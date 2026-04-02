'use strict';

/**
 * A-02 — Cold Email Outreach
 *
 * SCENARIO 2: Cold Outreach Reply Handler
 *
 * Two entry points:
 *
 * [1] handleColdEmailBatch(tenantId, payload, config)
 *     Triggered manually or by scheduler (daily).
 *     Fetches warm prospects, generates personalised emails via OpenAI,
 *     sends via Brevo, logs in `outreach_emails`.
 *
 *     Payload (optional overrides):
 *       { lead_ids, source, campaign, batch_size }
 *     If lead_ids provided → sends to only those leads (used by I-03 re-engage).
 *     Otherwise → auto-selects prospects from DB.
 *
 * [2] handleEmailReply(tenantId, payload, config)
 *     Called by brevo-webhooks.js when workflow_id=A-02 replied event fires.
 *     Payload: { message_id, prospect_email, reply_text, original_subject }
 *
 *     Flow:
 *       → AI classifies reply intent (interested/question/not_interested/referral/ooo)
 *       → If interested or question:
 *           WhatsApp to sales_rep_phone with reply excerpt + AI suggested opener
 *           Store pending WA action: email_reply_handoff
 *       → Update prospect status in DB
 *
 * Webhook: POST /webhook/:tenantSlug/cold-email-batch
 * Brevo:   Handled via brevo-webhooks.js → calls handleEmailReply()
 */

const OpenAI           = require('openai');
const { createClient } = require('@supabase/supabase-js');
const whatsapp         = require('../../shared/whatsapp');
const { sendColdEmail }     = require('../../shared/email');
const { storePendingAction } = require('../../api/whatsapp-reply-router');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
function ai() { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }

// ─────────────────────────────────────────────────────────────
// [1] Batch send
// ─────────────────────────────────────────────────────────────

async function handleColdEmailBatch(tenantId, payload = {}, config) {
  const {
    lead_ids   = null,
    source     = 'scheduled',
    campaign   = 'cold_outreach',
    batch_size = 20,
  } = payload;

  // ── Fetch prospects ───────────────────────────────────────
  let prospects;

  if (lead_ids && Array.isArray(lead_ids) && lead_ids.length > 0) {
    // Specific IDs provided (from I-03 re-engage or manual trigger)
    const { data } = await sb()
      .from('leads')
      .select('id, name, email, company, source, notes, score, signals')
      .eq('tenant_id', tenantId)
      .in('id', lead_ids)
      .not('status', 'in', '("bounced","unsubscribed","qualified","dismissed")');
    prospects = data || [];
  } else {
    // Auto-select warm/cold leads not contacted in last 7 days
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data } = await sb()
      .from('leads')
      .select('id, name, email, company, source, notes, score, signals, last_contacted_at')
      .eq('tenant_id', tenantId)
      .in('status', ['new', 'cold', 'warm'])
      .or(`last_contacted_at.is.null,last_contacted_at.lt.${cutoff}`)
      .gte('score', 20)
      .order('score', { ascending: false })
      .limit(batch_size);
    prospects = data || [];
  }

  if (prospects.length === 0) {
    return { ok: true, workflow: 'A-02', sent_count: 0, message: 'No eligible prospects' };
  }

  // ── Generate + send emails ────────────────────────────────
  const results = [];

  for (const prospect of prospects) {
    try {
      const email = await _generateColdEmail(prospect, config, campaign);

      await sendColdEmail({
        tenantConfig: config,
        to:           prospect.email,
        name:         prospect.name,
        subject:      email.subject,
        body:         email.body,
      });

      // Log in outreach_emails for reply tracking via Brevo webhook
      await sb().from('outreach_emails').insert({
        tenant_id:    tenantId,
        lead_id:      prospect.id,
        email:        prospect.email,
        name:         prospect.name,
        subject:      email.subject,
        body_excerpt: email.body.slice(0, 300),
        campaign,
        source,
        workflow_id:  'A-02',
        status:       'sent',
        sent_at:      new Date().toISOString(),
      }).catch(() => {});

      // Update lead's last_contacted_at
      await sb().from('leads')
        .update({ last_contacted_at: new Date().toISOString(), status: 'contacted' })
        .eq('id', prospect.id);

      results.push({ email: prospect.email, sent: true, subject: email.subject });
    } catch (err) {
      console.error(`[A-02] Failed to send to ${prospect.email}:`, err.message);
      results.push({ email: prospect.email, sent: false, error: err.message });
    }
  }

  const sent_count = results.filter(r => r.sent).length;
  return { ok: true, workflow: 'A-02', sent_count, total: prospects.length, results };
}

// ─────────────────────────────────────────────────────────────
// [2] Reply handler (called from brevo-webhooks.js)
// ─────────────────────────────────────────────────────────────

async function handleEmailReply(tenantId, payload, config) {
  const { message_id, prospect_email, reply_text, original_subject } = payload;

  if (!prospect_email || !reply_text) {
    return { ok: false, error: 'prospect_email and reply_text required' };
  }

  // ── Find the original outreach record ─────────────────────
  let outreach = null;
  if (message_id) {
    const { data } = await sb()
      .from('outreach_emails')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('message_id', message_id)
      .single()
      .catch(() => ({ data: null }));
    outreach = data;
  }

  // Fallback: find by email
  if (!outreach) {
    const { data } = await sb()
      .from('outreach_emails')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('email', prospect_email)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single()
      .catch(() => ({ data: null }));
    outreach = data;
  }

  const prospectName    = outreach?.name || prospect_email.split('@')[0];
  const subjectContext  = original_subject || outreach?.subject || '';

  // ── AI intent classification ──────────────────────────────
  const classification = await _classifyReplyIntent(reply_text, subjectContext, config);

  // ── Update prospect status ────────────────────────────────
  const newStatus = classification.intent === 'not_interested' ? 'opted_out'
                  : classification.intent === 'ooo'            ? 'ooo'
                  : 'replied';

  if (outreach?.lead_id) {
    await sb().from('leads')
      .update({ status: newStatus, last_reply_at: new Date().toISOString() })
      .eq('id', outreach.lead_id);
  }

  if (outreach?.id) {
    await sb().from('outreach_emails')
      .update({ status: 'replied', reply_received_at: new Date().toISOString() })
      .eq('id', outreach.id);
  }

  // ── WhatsApp alert for actionable replies ─────────────────
  let wa_sent = false;
  const salesRepPhone = config.sales_rep_phone || config.ceo_phone;
  const actionableIntents = ['interested', 'question', 'referral'];

  if (actionableIntents.includes(classification.intent) && salesRepPhone) {
    const waResult = await whatsapp.sendEmailReplyAlert(salesRepPhone, {
      prospect_name:    prospectName,
      prospect_email,
      original_subject: subjectContext,
      reply_excerpt:    reply_text.slice(0, 400),
      intent:           classification.intent,
      suggested_opener: classification.suggested_opener,
    });

    wa_sent = !!waResult.message_id;

    if (wa_sent) {
      await storePendingAction({
        tenantId,
        phone:       salesRepPhone,
        contextType: 'email_reply_handoff',
        contextData: {
          prospect_id:      outreach?.lead_id || null,
          prospect_email,
          prospect_name:    prospectName,
          reply_text:       reply_text.slice(0, 500),
          original_subject: subjectContext,
          intent:           classification.intent,
          suggested_opener: classification.suggested_opener,
        },
        ttlHours: 48,
      });
    }
  }

  return {
    ok:      true,
    workflow: 'A-02',
    intent:  classification.intent,
    wa_sent,
    status:  newStatus,
  };
}

// ─────────────────────────────────────────────────────────────
// AI helpers
// ─────────────────────────────────────────────────────────────

async function _generateColdEmail(prospect, config, campaign) {
  const model  = config.ai_model_standard || 'gpt-4o-mini';
  const brand  = config.brand_name || 'our brand';
  const voice  = config.brand_voice || 'professional, helpful, concise';
  const store  = config.store_url || '';
  const signals = (prospect.signals || []).join(', ') || prospect.notes || 'general interest';

  const prompt = [
    `Write a short, personalised cold outreach email for ${brand} (${store}).`,
    `Brand voice: ${voice}`,
    `Campaign: ${campaign}`,
    ``,
    `Recipient:`,
    `Name: ${prospect.name}`,
    `Company: ${prospect.company || 'unknown'}`,
    `Lead signals: ${signals}`,
    ``,
    `Requirements:`,
    `- Subject line: under 55 characters, no spam words`,
    `- Body: 3–4 short paragraphs, max 150 words total`,
    `- Personalise using their name and company if available`,
    `- End with a soft CTA (book a call, reply to this email, or visit the store)`,
    `- Do NOT use emojis`,
    ``,
    `Respond ONLY with valid JSON — no markdown, no extra text:`,
    `{"subject": "...", "body": "..."}`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens:  400,
    });
    return JSON.parse(completion.choices[0].message.content.trim());
  } catch (err) {
    console.error('[A-02] Email generation failed:', err.message);
    return {
      subject: `A quick note from ${config.brand_name}`,
      body: `Hi ${prospect.name},\n\nI wanted to reach out personally from ${config.brand_name}. Based on your interest, I think we could be a great fit.\n\nWould you be open to a quick chat?\n\nBest,\n${config.brand_name} Team`,
    };
  }
}

async function _classifyReplyIntent(replyText, subjectContext, config) {
  const model = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = [
    `Classify the intent of this email reply and suggest a follow-up opener.`,
    ``,
    `Original email subject: ${subjectContext || 'cold outreach'}`,
    `Reply text: "${replyText.slice(0, 800)}"`,
    ``,
    `Intent options:`,
    `- "interested" — positive response, wants to know more`,
    `- "question"   — asking a specific question about the product/service`,
    `- "referral"   — referring to someone else`,
    `- "not_interested" — politely declining`,
    `- "ooo"        — out of office auto-reply`,
    `- "other"      — anything else`,
    ``,
    `Respond ONLY with valid JSON — no markdown, no extra text:`,
    `{"intent": "...", "summary": "one sentence", "suggested_opener": "first sentence of a follow-up message under 30 words"}`,
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
    return { intent: 'other', summary: 'Reply received', suggested_opener: 'Thanks for getting back to me!' };
  }
}

module.exports = {
  handleColdEmail: handleColdEmailBatch,   // orchestrator uses this name
  handleColdEmailBatch,
  handleEmailReply,
};
