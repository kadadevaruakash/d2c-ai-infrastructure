'use strict';

/**
 * A-01 — Lead Capture
 *
 * SCENARIO 1: Hot Lead Instant Qualification Loop
 *
 * Flow:
 *   1. Validate + deduplicate lead (name + email required)
 *   2. OpenAI scores lead 0–100 and classifies hot / warm / cold
 *      extracting up to 5 intent signals from the submission
 *   3. Upsert into `leads` table
 *   4. If HOT (score >= threshold, default 70):
 *      → WhatsApp to sales_rep_phone with structured lead card
 *      → Store pending WA action: context_type 'lead_qualify'
 *      → Rep replies QUALIFY → SC-03 email sequence fires
 *      → Rep replies PASS   → lead marked dismissed
 *      → Rep replies INFO   → full profile sent back
 *   5. Return { lead_id, score, classification, wa_sent }
 *
 * Webhook: POST /webhook/:tenantSlug/lead-capture
 * Payload:
 *   {
 *     name:    string (required)
 *     email:   string (required)
 *     phone:   string (optional)
 *     company: string (optional)
 *     source:  string (optional) e.g. 'landing_page', 'referral', 'ig_ad'
 *     message: string (optional) — free-text from contact form
 *   }
 */

const OpenAI           = require('openai');
const { createClient } = require('@supabase/supabase-js');
const whatsapp         = require('../../shared/whatsapp');
const { storePendingAction } = require('../../api/whatsapp-reply-router');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function ai() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

async function handleLeadCapture(tenantId, payload, config) {
  const { name, email, phone, company, source, message } = payload;

  // ── 1. Validate ───────────────────────────────────────────
  if (!name || !email) {
    return { ok: false, error: 'name and email are required', workflow: 'A-01' };
  }

  const threshold = config.lead_hot_score_threshold || 70;

  // ── 2. Deduplicate ────────────────────────────────────────
  const { data: existing } = await sb()
    .from('leads')
    .select('id, score, status')
    .eq('tenant_id', tenantId)
    .eq('email', email.toLowerCase().trim())
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
    .catch(() => ({ data: null }));

  if (existing && existing.status === 'qualified') {
    return {
      ok: true, workflow: 'A-01', duplicate: true,
      lead_id: existing.id, score: existing.score,
      classification: 'warm', wa_sent: false,
      message: 'Lead already qualified — skipping',
    };
  }

  // ── 3. AI scoring ─────────────────────────────────────────
  const scoring = await _scoreLead({ name, email, company, source, message }, config);

  // ── 4. Upsert lead ────────────────────────────────────────
  const leadRow = {
    tenant_id:      tenantId,
    name:           name.trim(),
    email:          email.toLowerCase().trim(),
    phone:          phone || null,
    company:        company || null,
    source:         source || 'direct',
    notes:          message || null,
    score:          scoring.score,
    category:       scoring.classification, // used by analytics query
    classification: scoring.classification,
    status:         'new',
    signals:        scoring.signals,
    created_at:     new Date().toISOString(),
  };

  const { data: lead, error: insertErr } = await sb()
    .from('leads')
    .upsert(leadRow, { onConflict: 'tenant_id,email' })
    .select('id')
    .single();

  if (insertErr || !lead) {
    console.error('[A-01] Failed to upsert lead:', insertErr?.message);
    return { ok: false, error: insertErr?.message, workflow: 'A-01' };
  }

  // ── 5. WhatsApp alert if HOT ──────────────────────────────
  let wa_sent = false;
  let wa_message_id = null;
  const salesRepPhone = config.sales_rep_phone || config.ceo_phone;

  if (scoring.classification === 'hot' && salesRepPhone) {
    const waResult = await whatsapp.sendLeadAlert(salesRepPhone, {
      id:             lead.id,
      name,
      email,
      phone:          phone || null,
      company:        company || null,
      score:          scoring.score,
      classification: scoring.classification,
      signals:        scoring.signals,
      source:         source || 'direct',
    }, config);

    wa_message_id = waResult.message_id;
    wa_sent = !!wa_message_id;

    if (wa_sent) {
      await storePendingAction({
        tenantId,
        phone:       salesRepPhone,
        contextType: 'lead_qualify',
        contextData: {
          lead_id: lead.id,
          email,
          name,
          score:   scoring.score,
          signals: scoring.signals,
        },
        ttlHours: 24,
      });
    }
  }

  return {
    ok:             true,
    workflow:       'A-01',
    lead_id:        lead.id,
    score:          scoring.score,
    classification: scoring.classification,
    signals:        scoring.signals,
    wa_sent,
    wa_message_id,
    // This field is read by the CASCADE_MAP condition in orchestrator.js
    // to decide whether to trigger SC-03
    classification_for_cascade: scoring.classification,
  };
}

// ─────────────────────────────────────────────────────────────
// AI lead scorer
// ─────────────────────────────────────────────────────────────

async function _scoreLead({ name, email, company, source, message }, config) {
  const brandName = config.brand_name || 'our brand';
  const model     = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = [
    `You are a lead scoring AI for ${brandName}, a D2C e-commerce brand.`,
    `Score the following lead submission from 0 to 100 and classify as hot, warm, or cold.`,
    ``,
    `Scoring guide:`,
    `- 70–100 (hot): Clear purchase intent, high-value company/role, specific product mention, urgency signals`,
    `- 40–69 (warm): Some interest, vague enquiry, newsletter/info request`,
    `- 0–39  (cold): No real intent, spam indicators, generic message`,
    ``,
    `Lead data:`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company || 'not provided'}`,
    `Source: ${source || 'direct'}`,
    `Message: ${message || 'no message'}`,
    ``,
    `Respond ONLY with valid JSON in this exact shape — no markdown, no extra text:`,
    `{"score": <number 0-100>, "classification": "hot"|"warm"|"cold", "signals": ["signal1", "signal2", "signal3"]}`,
    `Signals should be short phrases (max 8 words each) explaining the score.`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens:  200,
    });

    const raw = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(raw);

    return {
      score:          Math.min(100, Math.max(0, Math.round(parsed.score))),
      classification: ['hot', 'warm', 'cold'].includes(parsed.classification)
                        ? parsed.classification : 'cold',
      signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 5) : [],
    };
  } catch (err) {
    console.error('[A-01] AI scoring failed:', err.message);
    // Fallback: simple heuristic
    const hasMessage = (message || '').length > 20;
    const hasBizEmail = !!email && !/@gmail|@yahoo|@hotmail|@outlook/.test(email);
    const score = (hasMessage ? 30 : 10) + (hasBizEmail ? 25 : 0) + (company ? 20 : 0);
    return {
      score,
      classification: score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold',
      signals: ['Fallback scoring (AI unavailable)'],
    };
  }
}

module.exports = { handleLeadCapture };
