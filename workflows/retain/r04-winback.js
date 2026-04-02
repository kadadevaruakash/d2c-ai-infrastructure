'use strict';

/**
 * R-04 — Winback Campaign
 *
 * Triggered: daily 9 AM (scheduler), or cascade from I-03 when churn_risk_score >= 0.7.
 * Runs a 3-stage escalating re-engagement sequence for lapsed customers.
 *
 * Stage 1 (30 days lapsed)  : Friendly check-in email + 5% discount
 * Stage 2 (60 days lapsed)  : "We miss you" email + 10% discount + free shipping
 * Stage 3 (90+ days lapsed) : Last-chance email + 15% discount + WhatsApp nudge to rep
 *
 * Scheduler export : runWinbackCampaign(tenantId, config)
 * Webhook export   : handleWinback(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const STAGES = [
  { days: 30, stage: 1, discount: 5,  subject_hint: 'friendly check-in',          label: 'Stage 1 — Check-in' },
  { days: 60, stage: 2, discount: 10, subject_hint: 'we miss you + free shipping', label: 'Stage 2 — We miss you' },
  { days: 90, stage: 3, discount: 15, subject_hint: 'last chance offer',           label: 'Stage 3 — Last chance' },
];

// ─────────────────────────────────────────────────────────────
// Email generator
// ─────────────────────────────────────────────────────────────

async function _generateWinbackEmail(customer, stage, config) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      subject: `${stage.subject_hint} from ${config.brand_name}`,
      body: `Hi ${customer.first_name || 'there'}, we miss you! Use code WINBACK${stage.discount} for ${stage.discount}% off.`,
    };
  }

  const daysSince = stage.days;
  const prompt = `Write a winback email for a D2C brand customer who hasn't purchased in ${daysSince} days.

Brand: ${config.brand_name}
Brand voice: ${config.brand_voice || 'warm and friendly'}
Customer first name: ${customer.first_name || 'there'}
Stage: ${stage.label}
Incentive: ${stage.discount}% discount${stage.stage >= 2 ? ' + free shipping' : ''}
Discount code: WINBACK${stage.discount}

Return ONLY valid JSON:
{
  "subject": "email subject line (compelling, under 60 chars)",
  "preview": "preview text under 90 chars",
  "body_html": "full HTML email body (use inline styles, no external CSS)"
}`;

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: config.ai_model_standard || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.6,
  }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });

  return JSON.parse(aiRes.data.choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────
// Send via Brevo
// ─────────────────────────────────────────────────────────────

async function _sendWinbackEmail(customer, emailContent, tenantId, stage, config) {
  if (!process.env.BREVO_API_KEY) return { ok: false, error: 'BREVO_API_KEY not set' };

  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender:  { name: config.brand_name, email: config.ops_email || process.env.BREVO_SENDER_EMAIL },
      to:      [{ email: customer.email, name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() }],
      subject: emailContent.subject,
      htmlContent: emailContent.body_html || `<p>${emailContent.body || ''}</p>`,
      headers: { 'X-Mailin-custom': `tenant_id:${tenantId}|workflow_id:R-04|stage:${stage.stage}` },
      params:  { FNAME: customer.first_name || '', DISCOUNT: stage.discount, CODE: `WINBACK${stage.discount}` },
    }, {
      headers: { 'api-key': process.env.BREVO_API_KEY },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Core handler — winback a single customer
// ─────────────────────────────────────────────────────────────

async function handleWinback(tenantId, payload, config) {
  const { customer_id, email, first_name, last_name, churn_risk, segment, days_since_purchase } = payload;

  if (!email) return { ok: false, error: 'customer email required' };

  // Determine stage from days lapsed or churn risk
  let stage = STAGES[0];
  if (days_since_purchase >= 90 || churn_risk >= 0.9) stage = STAGES[2];
  else if (days_since_purchase >= 60 || churn_risk >= 0.8) stage = STAGES[1];

  const customer = { customer_id, email, first_name, last_name };

  // Check if already sent this stage recently (dedup)
  const { data: existing } = await sb()
    .from('winback_campaigns')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customer_id)
    .eq('stage', stage.stage)
    .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .single()
    .catch(() => ({ data: null }));

  if (existing) return { ok: true, workflow: 'R-04', skipped: true, reason: 'already_sent_this_stage' };

  const emailContent = await _generateWinbackEmail(customer, stage, config);
  const sendResult   = await _sendWinbackEmail(customer, emailContent, tenantId, stage, config);

  // ── Log campaign ──────────────────────────────────────────
  await sb().from('winback_campaigns').insert({
    tenant_id:    tenantId,
    customer_id:  customer_id || null,
    email,
    first_name:   first_name || null,
    stage:        stage.stage,
    discount_pct: stage.discount,
    subject:      emailContent.subject,
    sent:         sendResult.ok,
    error:        sendResult.error || null,
    churn_risk:   churn_risk || null,
    created_at:   new Date().toISOString(),
  }).catch(() => {});

  // Stage 3 — also notify sales rep via WhatsApp
  if (stage.stage === 3 && sendResult.ok) {
    await notify(
      config,
      'winback',
      `⚠️ *Winback Stage 3* — Last-chance email sent to ${email}.\nRisk: ${churn_risk ? Math.round(churn_risk * 100) + '%' : 'high'}\nConsider a personal outreach call.`,
      'warning'
    ).catch(() => {});
  }

  return {
    ok:        sendResult.ok,
    workflow:  'R-04',
    stage:     stage.stage,
    label:     stage.label,
    email,
    subject:   emailContent.subject,
    discount:  stage.discount,
    error:     sendResult.error,
  };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner — find lapsed customers and enrol them
// ─────────────────────────────────────────────────────────────

async function runWinbackCampaign(tenantId, config) {
  const winbackDays = config.winback_stage2_days || 60;
  const since = new Date(Date.now() - 90 * 86400000).toISOString();

  // Find customers with high churn risk not yet converted
  const { data: candidates } = await sb()
    .from('customer_profiles')
    .select('customer_id, email, first_name, last_name, churn_risk_score, last_order_at')
    .eq('tenant_id', tenantId)
    .gte('churn_risk_score', 0.6)
    .lte('last_order_at', new Date(Date.now() - winbackDays * 86400000).toISOString())
    .order('churn_risk_score', { ascending: false })
    .limit(50)
    .catch(() => ({ data: [] }));

  if (!candidates || candidates.length === 0) return;

  let sent = 0;
  for (const c of candidates) {
    const daysSince = c.last_order_at
      ? Math.floor((Date.now() - new Date(c.last_order_at).getTime()) / 86400000)
      : 60;
    try {
      const r = await handleWinback(tenantId, {
        customer_id:        c.customer_id,
        email:              c.email,
        first_name:         c.first_name,
        last_name:          c.last_name,
        churn_risk:         c.churn_risk_score,
        days_since_purchase: daysSince,
      }, config);
      if (r.ok && !r.skipped) sent++;
    } catch (err) {
      console.error(`[R-04] Failed for ${c.email}:`, err.message);
    }
  }

  if (sent > 0) {
    console.log(`[R-04] tenant=${tenantId} winback emails sent=${sent}`);
  }
}

module.exports = { handleWinback, runWinbackCampaign };
