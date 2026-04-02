'use strict';

/**
 * A-03 — Instagram DM Bot
 *
 * SCENARIO 3: IG DM Escalation to WhatsApp
 *
 * FIXED BUG: Previously sent replies to WhatsApp API instead of Instagram
 * Messaging API. This version uses the correct Graph API endpoint.
 *
 * Flow:
 *   1. Parse Meta webhook (entry → messaging → message)
 *   2. Fetch sender's IG display name via Graph API
 *   3. AI scores purchase intent (0–100) with confidence + intent_type
 *   4. If confidence >= 70% AND intent is buy / question:
 *      → Auto-generate reply (brand voice, max 160 chars)
 *      → Send via Instagram Messaging API  ← CORRECT API (was broken before)
 *      → Log in `ig_conversations`
 *   5. If confidence < 70% (ambiguous):
 *      → WhatsApp to sales_rep_phone with DM context
 *      → Store pending WA action: context_type 'ig_reply'
 *      → Rep types their response in WhatsApp
 *      → Reply is forwarded to Instagram via sendInstagramReply()
 *   6. Ignore spam / complaint / irrelevant DMs after logging
 *
 * Webhook: POST /webhook/:tenantSlug/ig-dm
 * Payload: Meta Graph API webhook — entry[0].messaging[0]
 *
 * Also exports:
 *   sendInstagramReply(igSenderId, text, config)
 *   — called by whatsapp-reply-router.js when rep sends an IG reply via WA
 */

const OpenAI           = require('openai');
const axios            = require('axios');
const { createClient } = require('@supabase/supabase-js');
const whatsapp         = require('../../shared/whatsapp');
const { storePendingAction } = require('../../api/whatsapp-reply-router');

const IG_API = 'https://graph.facebook.com/v19.0';

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
function ai() { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

async function handleIgDm(tenantId, payload, config) {
  // ── 1. Parse Meta webhook payload ────────────────────────
  const messaging = _extractMessaging(payload);
  if (!messaging) {
    return { ok: true, workflow: 'A-03', handled: false, reason: 'no_message' };
  }

  const { sender_id, message_text, message_id, timestamp } = messaging;

  // Ignore echo (messages sent by the page itself)
  if (messaging.is_echo) {
    return { ok: true, workflow: 'A-03', handled: false, reason: 'echo' };
  }

  // ── 2. Fetch sender display name ──────────────────────────
  const senderInfo = await _getIgUserInfo(sender_id, config);
  const ig_username = senderInfo.username || sender_id;

  // ── 3. Log inbound message ────────────────────────────────
  await sb().from('ig_conversations').insert({
    tenant_id:    tenantId,
    ig_sender_id: sender_id,
    ig_username,
    direction:    'inbound',
    message:      message_text,
    message_id,
    created_at:   new Date(timestamp * 1000 || Date.now()).toISOString(),
  }).catch(() => {});

  // ── 4. AI intent scoring ──────────────────────────────────
  const intent = await _scoreIgIntent(message_text, ig_username, config);

  // Silently ignore spam / complaint DMs after logging
  if (['spam', 'complaint', 'irrelevant'].includes(intent.intent_type)) {
    return { ok: true, workflow: 'A-03', handled: true, action: 'ignored', intent: intent.intent_type };
  }

  // ── 5a. High confidence → auto-reply on Instagram ─────────
  if (intent.confidence >= 70 && ['buy', 'question', 'restock'].includes(intent.intent_type)) {
    const autoReply = await _generateIgReply(message_text, intent, config);
    const sent      = await sendInstagramReply(sender_id, autoReply, config);

    if (sent.ok) {
      await sb().from('ig_conversations').insert({
        tenant_id:    tenantId,
        ig_sender_id: sender_id,
        ig_username,
        direction:    'outbound',
        message:      autoReply,
        created_at:   new Date().toISOString(),
      }).catch(() => {});

      return {
        ok: true, workflow: 'A-03', handled: true,
        action: 'auto_replied', intent: intent.intent_type,
        confidence: intent.confidence, reply: autoReply,
      };
    }
    // If IG send failed fall through to escalation
    console.warn('[A-03] Instagram auto-reply failed, escalating to WhatsApp');
  }

  // ── 5b. Low confidence or failed send → WA escalation ────
  const salesRepPhone = config.sales_rep_phone || config.ceo_phone;
  if (!salesRepPhone) {
    return {
      ok: true, workflow: 'A-03', handled: false,
      reason: 'no_rep_phone_configured', intent: intent.intent_type,
    };
  }

  const waResult = await whatsapp.sendIgEscalation(salesRepPhone, {
    ig_username,
    message_excerpt: message_text.slice(0, 500),
    intent_type:     intent.intent_type,
    confidence:      intent.confidence,
    ig_sender_id:    sender_id,
  });

  const wa_sent = !!waResult.message_id;

  if (wa_sent) {
    await storePendingAction({
      tenantId,
      phone:       salesRepPhone,
      contextType: 'ig_reply',
      contextData: {
        ig_sender_id:     sender_id,
        ig_username,
        original_message: message_text,
        intent_type:      intent.intent_type,
        confidence:       intent.confidence,
      },
      ttlHours: 8, // IG DMs go stale faster than leads
    });
  }

  return {
    ok: true, workflow: 'A-03', handled: true,
    action: 'escalated_to_whatsapp',
    intent: intent.intent_type, confidence: intent.confidence,
    wa_sent,
  };
}

// ─────────────────────────────────────────────────────────────
// Instagram Messaging API — send reply
// ─────────────────────────────────────────────────────────────

/**
 * Send a reply to an Instagram DM.
 * This is the CORRECT API endpoint — the bug was using WHATSAPP_PHONE_NUMBER_ID here.
 *
 * Called by:
 *   - handleIgDm() for auto-replies
 *   - whatsapp-reply-router.js _handleIgReply() for human replies via WA
 *
 * @param {string} igSenderId  - Instagram Scoped User ID (IGSID)
 * @param {string} text        - Reply text (max 1000 chars)
 * @param {object} config      - Tenant config (needs ig_page_id or reads env)
 */
async function sendInstagramReply(igSenderId, text, config) {
  const pageId    = config.ig_page_id    || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const pageToken = config.ig_page_token || process.env.INSTAGRAM_ACCESS_TOKEN;

  if (!pageId || !pageToken) {
    return { ok: false, error: 'Instagram credentials not configured' };
  }

  try {
    await axios.post(
      `${IG_API}/${pageId}/messages`,
      {
        recipient: { id: igSenderId },
        message:   { text: text.slice(0, 1000) },
        messaging_type: 'RESPONSE',
      },
      {
        params:  { access_token: pageToken },
        headers: { 'Content-Type': 'application/json' },
      }
    );
    return { ok: true };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('[A-03] Instagram reply failed:', detail);
    return { ok: false, error: detail };
  }
}

// ─────────────────────────────────────────────────────────────
// AI helpers
// ─────────────────────────────────────────────────────────────

async function _scoreIgIntent(messageText, igUsername, config) {
  const brand = config.brand_name || 'our brand';
  const model = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = [
    `You analyse Instagram DMs for ${brand}, a D2C e-commerce brand.`,
    `Score the purchase intent of this message and classify it.`,
    ``,
    `Instagram username: @${igUsername}`,
    `Message: "${messageText.slice(0, 600)}"`,
    ``,
    `Intent types:`,
    `- "buy"        — wants to purchase, asks about pricing, availability, checkout`,
    `- "question"   — asking about product details, shipping, returns`,
    `- "restock"    — asking when a sold-out item will be back`,
    `- "complaint"  — negative experience, upset customer`,
    `- "spam"       — promotional, bot, irrelevant`,
    `- "irrelevant" — not related to purchasing at all`,
    ``,
    `Confidence: how certain you are about the intent (0–100).`,
    ``,
    `Respond ONLY with valid JSON — no markdown, no extra text:`,
    `{"intent_type": "...", "confidence": <number 0-100>, "summary": "one sentence"}`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens:  150,
    });
    const parsed = JSON.parse(completion.choices[0].message.content.trim());
    return {
      intent_type: parsed.intent_type || 'irrelevant',
      confidence:  Math.min(100, Math.max(0, parsed.confidence || 0)),
      summary:     parsed.summary || '',
    };
  } catch {
    return { intent_type: 'irrelevant', confidence: 0, summary: 'AI unavailable' };
  }
}

async function _generateIgReply(originalMessage, intent, config) {
  const brand = config.brand_name || 'our brand';
  const store = config.store_url  || '';
  const voice = config.brand_voice || 'warm, helpful, brief';
  const model = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = [
    `Write a short Instagram DM reply for ${brand}.`,
    `Brand voice: ${voice}`,
    `Store URL: ${store}`,
    ``,
    `Customer DM: "${originalMessage.slice(0, 400)}"`,
    `Intent detected: ${intent.intent_type}`,
    ``,
    `Requirements:`,
    `- Max 160 characters (Instagram DM limit for display)`,
    `- Warm, personal tone (no corporate speak)`,
    `- Include store URL if relevant`,
    `- Do not use bullet points`,
    ``,
    `Respond with just the reply text — no quotes, no JSON.`,
  ].join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens:  80,
    });
    return completion.choices[0].message.content.trim().slice(0, 1000);
  } catch {
    return `Hi! Thanks for reaching out to ${brand}. Check out our store: ${store}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function _extractMessaging(payload) {
  try {
    const entry     = payload?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging || !messaging.message) return null;
    return {
      sender_id:    messaging.sender?.id,
      message_text: messaging.message?.text || '',
      message_id:   messaging.message?.mid  || null,
      timestamp:    messaging.timestamp      || null,
      is_echo:      messaging.message?.is_echo || false,
    };
  } catch {
    return null;
  }
}

async function _getIgUserInfo(igSenderId, config) {
  const pageToken = config.ig_page_token || process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!pageToken) return { username: igSenderId };
  try {
    const { data } = await axios.get(`${IG_API}/${igSenderId}`, {
      params: { fields: 'name,username', access_token: pageToken },
    });
    return { username: data.username || data.name || igSenderId };
  } catch {
    return { username: igSenderId };
  }
}

module.exports = { handleIgDm, sendInstagramReply };
