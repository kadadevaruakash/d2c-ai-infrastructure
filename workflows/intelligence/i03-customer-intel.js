'use strict';

/**
 * I-03 — Customer Intelligence
 *
 * SCENARIO 5: Lead Score Drop Alert → WhatsApp → Re-engagement
 *
 * Two responsibilities:
 *
 * [1] handleCustomerIntel(tenantId, payload, config)
 *     Event-driven: called when a customer does something (purchase, abandon, etc).
 *     Updates RFM profile + churn risk score for one customer.
 *     Triggers R-04 cascade if churn_risk >= threshold.
 *
 * [2] handleColdLeadScan(tenantId, payload, config)
 *     Scheduled: runs daily (via scheduler.js) to detect warm leads gone cold.
 *     Groups cold leads by value tier (high/mid/low).
 *     Sends WhatsApp digest to sales lead phone.
 *     Stores pending WA action: cold_lead_reengage.
 *     Sales lead replies RE-ENGAGE ALL/HIGH/MID → A-02 fires for that segment.
 *
 * CASCADE INTEGRATION:
 *   I-03 is triggered by R-01, C-01, C-04 cascades (see orchestrator.js).
 *   I-03 triggers R-04 when churn_risk >= threshold.
 *   The churn_risk_score field in the return value is read by CASCADE_MAP.
 *
 * Webhook: POST /webhook/:tenantSlug/customer-intel
 * Scheduler: daily at 08:00 via scheduler.js
 */

const OpenAI           = require('openai');
const { createClient } = require('@supabase/supabase-js');
const whatsapp         = require('../../shared/whatsapp');
const { storePendingAction } = require('../../api/whatsapp-reply-router');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
function ai() { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }

// ─────────────────────────────────────────────────────────────
// [1] Per-customer event handler
// ─────────────────────────────────────────────────────────────

async function handleCustomerIntel(tenantId, payload, config) {
  const {
    event_type,   // 'purchase' | 'repeated_abandonment' | 'gamification_engaged' | 'custom'
    customer_id,
    email,
    metadata = {},
  } = payload;

  if (!customer_id && !email) {
    return { ok: false, error: 'customer_id or email required', workflow: 'I-03' };
  }

  const threshold = config.churn_risk_threshold || 0.7;

  // ── Load or create customer profile ──────────────────────
  const profile = await _loadOrCreateProfile(tenantId, customer_id, email);

  // ── Update RFM signals from event ────────────────────────
  const updated = _applyEvent(profile, event_type, metadata);

  // ── AI churn risk scoring ─────────────────────────────────
  const churnScore = await _scoreChurnRisk(updated, config);

  // ── Persist updated profile ───────────────────────────────
  await sb().from('customer_profiles').upsert({
    tenant_id:        tenantId,
    customer_id:      customer_id || null,
    email:            email || profile.email,
    recency_days:     updated.recency_days,
    frequency:        updated.frequency,
    monetary_value:   updated.monetary_value,
    segment:          churnScore.segment,
    churn_risk_score: churnScore.score,
    churn_reason:     churnScore.reason,
    last_event:       event_type,
    last_event_at:    new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }, { onConflict: 'tenant_id,email' });

  return {
    ok: true, workflow: 'I-03',
    customer_id: customer_id || profile.customer_id,
    email:       email || profile.email,
    segment:     churnScore.segment,
    churn_risk_score: churnScore.score, // READ BY CASCADE_MAP to trigger R-04
    churn_reason:     churnScore.reason,
    rfm: {
      recency_days:   updated.recency_days,
      frequency:      updated.frequency,
      monetary_value: updated.monetary_value,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// [2] Cold lead scan (Scenario 5 — scheduled)
// ─────────────────────────────────────────────────────────────

async function handleColdLeadScan(tenantId, payload = {}, config) {
  const lookbackDays   = payload.lookback_days || 30;
  const coldThreshold  = payload.cold_days     || 7;   // no activity for 7+ days = cold
  const scoreFloor     = payload.score_floor   || 50;  // only scan leads that were warm+

  const cutoffDate     = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const activeCutoff   = new Date(Date.now() - coldThreshold  * 86400000).toISOString();

  // ── Fetch warm/hot leads created in window ────────────────
  const { data: leads } = await sb()
    .from('leads')
    .select('id, name, email, score, classification, last_contacted_at, source, signals')
    .eq('tenant_id', tenantId)
    .gte('score', scoreFloor)
    .gte('created_at', cutoffDate)
    .not('status', 'in', '("qualified","dismissed","opted_out","bounced")')
    .order('score', { ascending: false });

  if (!leads || leads.length === 0) {
    return { ok: true, workflow: 'I-03', cold_count: 0, message: 'No cold leads detected' };
  }

  // ── Cross-reference with email activity ───────────────────
  const leadEmails = leads.map(l => l.email);
  const { data: recentActivity } = await sb()
    .from('email_events')
    .select('recipient_email, event_type, created_at')
    .eq('tenant_id', tenantId)
    .in('recipient_email', leadEmails)
    .in('event_type', ['opened', 'clicked', 'replied'])
    .gte('created_at', activeCutoff);

  const activeEmails = new Set((recentActivity || []).map(e => e.recipient_email));

  // A lead is "cold" if they haven't opened/clicked in the last `coldThreshold` days
  const coldLeads = leads.filter(l => {
    const hasRecentActivity = activeEmails.has(l.email);
    const hasRecentContact  = l.last_contacted_at && l.last_contacted_at > activeCutoff;
    return !hasRecentActivity && !hasRecentContact;
  });

  if (coldLeads.length === 0) {
    return { ok: true, workflow: 'I-03', cold_count: 0, message: 'All leads are still engaged' };
  }

  // ── Segment by value tier ─────────────────────────────────
  const HIGH_THRESHOLD = 70;
  const MID_THRESHOLD  = 50;

  const high = coldLeads.filter(l => l.score >= HIGH_THRESHOLD);
  const mid  = coldLeads.filter(l => l.score >= MID_THRESHOLD && l.score < HIGH_THRESHOLD);

  const segments = {
    total:    coldLeads.length,
    high: {
      count:     high.length,
      avg_score: _avg(high.map(l => l.score)),
      ids:       high.map(l => l.id),
    },
    mid: {
      count:     mid.length,
      avg_score: _avg(mid.map(l => l.score)),
      ids:       mid.map(l => l.id),
    },
    all_ids: coldLeads.map(l => l.id),
    top_leads: coldLeads.slice(0, 15).map(l => ({
      id:               l.id,
      name:             l.name,
      email:            l.email,
      score:            l.score,
      last_contacted_at: l.last_contacted_at,
    })),
  };

  // ── WhatsApp digest to sales lead ─────────────────────────
  const salesLeadPhone = config.sales_lead_phone || config.sales_rep_phone || config.ceo_phone;
  let wa_sent = false;

  if (salesLeadPhone && coldLeads.length > 0) {
    const waResult = await whatsapp.sendColdLeadDigest(salesLeadPhone, segments, config);
    wa_sent = !!waResult.message_id;

    if (wa_sent) {
      await storePendingAction({
        tenantId,
        phone:       salesLeadPhone,
        contextType: 'cold_lead_reengage',
        contextData: segments,
        ttlHours:    24,
      });
    }
  }

  return {
    ok:        true,
    workflow:  'I-03',
    cold_count: coldLeads.length,
    segments,
    wa_sent,
  };
}

// ─────────────────────────────────────────────────────────────
// RFM helpers
// ─────────────────────────────────────────────────────────────

async function _loadOrCreateProfile(tenantId, customerId, email) {
  const query = customerId
    ? sb().from('customer_profiles').select('*').eq('tenant_id', tenantId).eq('customer_id', customerId)
    : sb().from('customer_profiles').select('*').eq('tenant_id', tenantId).eq('email', email);

  const { data } = await query.single().catch(() => ({ data: null }));

  return data || {
    customer_id:      customerId || null,
    email:            email || null,
    recency_days:     999,
    frequency:        0,
    monetary_value:   0,
    churn_risk_score: 0,
    segment:          'new',
  };
}

function _applyEvent(profile, eventType, metadata) {
  const updated = { ...profile };

  if (eventType === 'purchase') {
    updated.recency_days   = 0;
    updated.frequency      = (profile.frequency || 0) + 1;
    updated.monetary_value = (profile.monetary_value || 0) + parseFloat(metadata.order_value || 0);
  }

  if (eventType === 'repeated_abandonment') {
    // Repeated abandonment increases churn risk — don't reset recency
    updated.recency_days = profile.recency_days; // unchanged
  }

  if (eventType === 'gamification_engaged') {
    // Engagement resets recency slightly
    updated.recency_days = Math.min(profile.recency_days || 999, 3);
  }

  return updated;
}

async function _scoreChurnRisk(profile, config) {
  const model = config.ai_model_standard || 'gpt-4o-mini';

  // Fast heuristic for common cases
  if (profile.frequency >= 5 && profile.recency_days <= 14) {
    return { score: 0.1, segment: 'champion', reason: 'Frequent recent buyer' };
  }
  if (profile.recency_days > 180 && profile.frequency <= 1) {
    return { score: 0.9, segment: 'at_risk', reason: 'Long inactivity after single purchase' };
  }

  // AI scoring for nuanced cases
  const prompt = [
    `Score the churn risk of this e-commerce customer from 0.0 to 1.0.`,
    ``,
    `Customer RFM data:`,
    `- Recency: ${profile.recency_days} days since last purchase`,
    `- Frequency: ${profile.frequency} orders`,
    `- Monetary: $${profile.monetary_value} total spend`,
    ``,
    `Scoring guide:`,
    `0.0–0.3: Low risk (active buyer)`,
    `0.3–0.7: Medium risk (at risk)`,
    `0.7–1.0: High risk (likely churning)`,
    ``,
    `Also assign a segment label: champion, loyal, at_risk, cant_lose, hibernating, lost`,
    ``,
    `Respond ONLY with valid JSON — no markdown:`,
    `{"score": 0.0, "segment": "...", "reason": "one sentence explanation"}`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens:  100,
    });
    const parsed = JSON.parse(completion.choices[0].message.content.trim());
    return {
      score:   Math.min(1, Math.max(0, parseFloat(parsed.score))),
      segment: parsed.segment || 'at_risk',
      reason:  parsed.reason || 'Model assessment',
    };
  } catch {
    // Heuristic fallback
    const score = Math.min(1, (profile.recency_days || 0) / 180);
    return {
      score,
      segment: score >= 0.7 ? 'at_risk' : score >= 0.3 ? 'hibernating' : 'loyal',
      reason: 'Heuristic: recency-based',
    };
  }
}

function _avg(nums) {
  if (!nums || nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

module.exports = {
  handleCustomerIntel,
  handleColdLeadScan,
};
