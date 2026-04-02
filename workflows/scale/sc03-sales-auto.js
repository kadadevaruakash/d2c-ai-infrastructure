'use strict';

/**
 * SC-03 — Sales Automation
 *
 * Qualifies inbound high-intent signals and hands off to sales rep via WhatsApp.
 *
 * Entry points:
 *
 * [1] handleSalesSignal(tenantId, payload, config)
 *     Triggered by:
 *       - SC-03 → A-01 cascade (high-intent signal creates lead)
 *       - A-01 → SC-03 cascade (hot lead triggers immediate follow-up)
 *       - WA reply router (rep QUALIFY reply from A-01)
 *       - Direct webhook: POST /webhook/:tenantSlug/sales-signal
 *
 *     Flow:
 *       1. AI qualifies intent: high / medium / low
 *       2. If high: create/update lead, send WA to sales rep (sales_handoff pending action),
 *          also fire Brevo follow-up email sequence
 *       3. If medium: add to warm nurture queue, fire A-02 cold email
 *       4. If low: log and skip
 *
 * Payload:
 *   {
 *     name:    string
 *     email:   string
 *     phone:   string (optional)
 *     company: string (optional)
 *     intent:  'high' | 'medium' | 'low'  (override — skips AI if provided)
 *     source:  string  e.g. 'contact_form', 'calendly', 'lead_qualify_wa'
 *     signal:  string  — free text description of the intent signal
 *     message: string  (optional) — original message from the lead
 *   }
 */

const OpenAI              = require('openai');
const { createClient }    = require('@supabase/supabase-js');
const whatsapp            = require('../../shared/whatsapp');
const { sendSalesFollowUp } = require('../../shared/email');
const { storePendingAction } = require('../../api/whatsapp-reply-router');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
function ai() { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

async function handleSalesSignal(tenantId, payload, config) {
  const {
    name,
    email,
    phone    = null,
    company  = null,
    signal   = '',
    source   = 'inbound',
    message  = '',
  } = payload;

  if (!email) {
    return { ok: false, error: 'email required', workflow: 'SC-03' };
  }

  // ── 1. Qualify intent (AI or use provided) ────────────────
  const intentOverride = payload.intent && ['high', 'medium', 'low'].includes(payload.intent)
    ? payload.intent : null;

  const qualification = intentOverride
    ? { qualification: intentOverride, intent_summary: signal || `${source} signal`, suggested_opener: null }
    : await _qualifyIntent({ name, email, company, signal, message, source }, config);

  // ── 2. Upsert lead record ─────────────────────────────────
  const score = qualification.qualification === 'high'   ? 85
              : qualification.qualification === 'medium' ? 55 : 25;

  const { data: lead } = await sb()
    .from('leads')
    .upsert({
      tenant_id:      tenantId,
      email:          email.toLowerCase().trim(),
      name:           name || email.split('@')[0],
      phone:          phone || null,
      company:        company || null,
      source,
      notes:          signal || message || null,
      score,
      category:       qualification.qualification === 'high' ? 'hot' : 'warm',
      classification: qualification.qualification === 'high' ? 'hot' : 'warm',
      status:         'new',
      created_at:     new Date().toISOString(),
    }, { onConflict: 'tenant_id,email' })
    .select('id')
    .single()
    .catch(() => ({ data: null }));

  const leadId = lead?.id || null;

  // ── 3. Route by qualification ─────────────────────────────
  let wa_sent = false;
  let email_sent = false;

  if (qualification.qualification === 'high') {
    // WhatsApp handoff to sales rep
    const salesRepPhone = config.sales_rep_phone || config.ceo_phone;
    if (salesRepPhone) {
      const opener = qualification.suggested_opener
        || await _generateOpener({ name, company, signal, message }, config);

      const waResult = await whatsapp.sendSalesHandoff(salesRepPhone, {
        lead_id:        leadId,
        name:           name || email,
        email,
        company,
        intent_summary: qualification.intent_summary,
        suggested_opener: opener,
        source,
      }, config);

      wa_sent = !!waResult.message_id;

      if (wa_sent) {
        await storePendingAction({
          tenantId,
          phone:       salesRepPhone,
          contextType: 'sales_handoff',
          contextData: {
            lead_id:        leadId,
            name:           name || email,
            email,
            company,
            intent_summary: qualification.intent_summary,
            source,
          },
          ttlHours: 48,
        });
      }
    }

    // Also fire email sequence
    try {
      await sendSalesFollowUp({
        tenantConfig: config,
        to:           email,
        message:      qualification.suggested_opener
                      || `Hi ${name || 'there'}, I saw your interest in ${config.brand_name} and wanted to reach out personally.`,
        calendlyUrl:  config.calendly_url,
      });
      email_sent = true;
    } catch (err) {
      console.error('[SC-03] Follow-up email failed:', err.message);
    }

  } else if (qualification.qualification === 'medium') {
    // Add to nurture: A-02 cold email sequence
    try {
      const { handleColdEmailBatch } = require('../acquire/a02-cold-email');
      await handleColdEmailBatch(tenantId, {
        lead_ids: leadId ? [leadId] : null,
        source:   'sc03_nurture',
        campaign: 'medium_intent_nurture',
      }, config);
      email_sent = true;
    } catch (err) {
      console.error('[SC-03] Nurture email failed:', err.message);
    }
  }

  return {
    ok:             true,
    workflow:       'SC-03',
    lead_id:        leadId,
    qualification:  qualification.qualification, // READ BY CASCADE_MAP (SC-03 → A-01)
    intent_summary: qualification.intent_summary,
    wa_sent,
    email_sent,
  };
}

// ─────────────────────────────────────────────────────────────
// AI helpers
// ─────────────────────────────────────────────────────────────

async function _qualifyIntent({ name, email, company, signal, message, source }, config) {
  const brand = config.brand_name || 'our brand';
  const model = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = [
    `Qualify the sales intent of this inbound signal for ${brand}.`,
    ``,
    `Lead: ${name || 'unknown'} (${email}), Company: ${company || 'unknown'}`,
    `Source: ${source}`,
    `Signal: ${signal || 'not specified'}`,
    `Message: ${(message || '').slice(0, 500)}`,
    ``,
    `Qualification levels:`,
    `- "high"   — clear purchase intent, ready to buy or talk now`,
    `- "medium" — curious, early research phase, needs nurturing`,
    `- "low"    — minimal intent, may be a competitor, researcher, or cold contact`,
    ``,
    `Respond ONLY with valid JSON — no markdown:`,
    `{"qualification":"high"|"medium"|"low","intent_summary":"one sentence","suggested_opener":"first sentence of outreach email under 25 words"}`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens:  200,
    });
    return JSON.parse(completion.choices[0].message.content.trim());
  } catch {
    return { qualification: 'medium', intent_summary: 'Inbound signal', suggested_opener: null };
  }
}

async function _generateOpener({ name, company, signal, message }, config) {
  const brand = config.brand_name || 'our brand';
  const model = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = [
    `Write the opening sentence of a sales outreach email for ${brand}.`,
    `Lead: ${name || 'prospect'}, Company: ${company || 'unknown'}`,
    `Signal: ${signal || message || 'inbound enquiry'}`,
    `Requirements: personalised, max 25 words, no emojis, natural tone.`,
    `Respond with just the sentence — no quotes.`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens:  60,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return `Hi ${name || 'there'}, I noticed your interest in ${brand} and wanted to connect.`;
  }
}

module.exports = { handleSalesSignal };
