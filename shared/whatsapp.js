'use strict';

/**
 * D2C AI Infrastructure — WhatsApp Business API Client
 *
 * Single source of truth for all outbound WhatsApp messages.
 * Replaces Slack as the internal ops + external customer channel.
 *
 * Uses Meta WhatsApp Business Cloud API (v19.0).
 *
 * Message types:
 *   sendText(phone, text)                — plain text
 *   sendList(phone, header, body, sections) — interactive list
 *   sendLeadAlert(phone, lead, config)   — Scenario 1: hot lead card to sales rep
 *   sendIgEscalation(phone, data)        — Scenario 3: IG DM escalation to rep
 *   sendSeoApproval(phone, draft, config) — Scenario 4: SEO draft approval to content manager
 *   sendColdLeadDigest(phone, segments, config) — Scenario 5: cold lead digest to sales lead
 *   sendSalesHandoff(phone, data, config) — SC-03: sales signal handoff to rep
 *   sendNotify(phone, message, level)    — generic ops alert replacing Slack
 */

const axios = require('axios');

const WA_API_VERSION = 'v19.0';

// ─────────────────────────────────────────────────────────────
// Core sender
// ─────────────────────────────────────────────────────────────

/**
 * Send any WhatsApp message payload.
 * Returns { message_id } on success.
 */
async function _send(payload) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.error('[whatsapp] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
    return { message_id: null, error: 'WhatsApp not configured' };
  }

  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', ...payload },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const message_id = data?.messages?.[0]?.id || null;
    return { message_id };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('[whatsapp] Send error:', detail);
    return { message_id: null, error: detail };
  }
}

// ─────────────────────────────────────────────────────────────
// Public send functions
// ─────────────────────────────────────────────────────────────

/**
 * Send a plain text message.
 * @param {string} phone  - E.164 format e.g. '+15551234567'
 * @param {string} text   - Message body (max 4096 chars)
 */
async function sendText(phone, text) {
  return _send({
    to: _clean(phone),
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) },
  });
}

/**
 * Send an interactive list message.
 * Useful for multi-choice prompts (approve/reject/edit).
 *
 * @param {string} phone
 * @param {string} headerText  - Bold header line
 * @param {string} bodyText    - Main message body
 * @param {string} buttonLabel - Button label (max 20 chars)
 * @param {Array}  sections    - [{ title, rows: [{ id, title, description }] }]
 */
async function sendList(phone, headerText, bodyText, buttonLabel, sections) {
  return _send({
    to: _clean(phone),
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText.slice(0, 60) },
      body:   { text: bodyText.slice(0, 1024) },
      action: {
        button: buttonLabel.slice(0, 20),
        sections,
      },
    },
  });
}

/**
 * Send a two-button interactive reply message.
 * Best for binary choices (Qualify/Pass, Approve/Reject).
 *
 * @param {string} phone
 * @param {string} bodyText
 * @param {Array}  buttons  - [{ id, title }] (max 3, title max 20 chars)
 */
async function sendButtons(phone, bodyText, buttons) {
  return _send({
    to: _clean(phone),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Scenario-specific senders
// ─────────────────────────────────────────────────────────────

/**
 * SCENARIO 1 — Hot Lead Alert to sales rep.
 * Sends a structured lead card with QUALIFY / PASS / INFO options.
 *
 * @param {string} phone         - Sales rep phone (from tenant_config.sales_rep_phone)
 * @param {object} lead          - { id, name, email, company, phone, score, classification, signals, source }
 * @param {object} tenantConfig  - Full tenant config row
 */
async function sendLeadAlert(phone, lead, tenantConfig) {
  const brand   = tenantConfig.brand_name || 'Your Store';
  const signals = (lead.signals || []).slice(0, 3).join(' · ') || 'No specific signals';
  const company = lead.company ? `\n🏢 ${lead.company}` : '';
  const src     = lead.source  ? ` via ${lead.source}` : '';

  const body = [
    `🔥 *Hot Lead Alert — ${brand}*`,
    ``,
    `👤 ${lead.name}${company}`,
    `📧 ${lead.email}`,
    `📊 Score: *${lead.score}/100*${src}`,
    ``,
    `Top signals:`,
    `${signals}`,
    ``,
    `Reply *QUALIFY* to start email sequence`,
    `Reply *PASS* to dismiss this lead`,
    `Reply *INFO* for full profile`,
  ].join('\n');

  return sendText(phone, body);
}

/**
 * SCENARIO 2 — Cold Email Reply Handoff to sales rep.
 * Fires when a prospect replies to an A-02 cold email.
 *
 * @param {string} phone    - Sales rep phone
 * @param {object} data     - { prospect_name, prospect_email, original_subject, reply_excerpt, intent, suggested_opener }
 */
async function sendEmailReplyAlert(phone, data) {
  const body = [
    `📬 *Prospect Replied — Cold Email*`,
    ``,
    `👤 ${data.prospect_name} (${data.prospect_email})`,
    `📧 Subject: _${data.original_subject}_`,
    ``,
    `Their reply:`,
    `"${(data.reply_excerpt || '').slice(0, 300)}"`,
    ``,
    `AI intent: *${data.intent}*`,
    ``,
    `Suggested opener:`,
    `"${data.suggested_opener}"`,
    ``,
    `Reply *CONTACT* to claim this lead`,
    `Reply *ASSIGN* to forward to team`,
    `Reply *PASS* to dismiss`,
  ].join('\n');

  return sendText(phone, body);
}

/**
 * SCENARIO 3 — IG DM Escalation to sales rep.
 * Fires when A-03 detects low-confidence purchase intent on an Instagram DM.
 *
 * @param {string} phone  - Sales rep phone
 * @param {object} data   - { ig_username, message_excerpt, intent_type, confidence, ig_sender_id }
 */
async function sendIgEscalation(phone, data) {
  const body = [
    `📸 *Instagram DM — Human Review Needed*`,
    ``,
    `From: @${data.ig_username}`,
    `Intent: ${data.intent_type} (${data.confidence}% confidence)`,
    ``,
    `Message:`,
    `"${(data.message_excerpt || '').slice(0, 400)}"`,
    ``,
    `Type your reply below — it will be sent back to them`,
    `on Instagram automatically.`,
    ``,
    `Or reply *SKIP* to ignore this DM.`,
  ].join('\n');

  return sendText(phone, body);
}

/**
 * SCENARIO 4 — SEO Content Draft Approval to content manager.
 * Fires when A-04 generates a new SEO draft that needs human sign-off.
 *
 * @param {string} phone    - Content manager phone (tenant_config.content_manager_phone)
 * @param {object} draft    - { product_title, seo_title, meta_description, keywords, body_excerpt, draft_id }
 * @param {object} config   - Tenant config
 */
async function sendSeoApproval(phone, draft, config) {
  const body = [
    `✍️ *SEO Draft Ready — ${config.brand_name}*`,
    ``,
    `Product: *${draft.product_title}*`,
    ``,
    `📌 Title (${(draft.seo_title || '').length} chars):`,
    `${draft.seo_title}`,
    ``,
    `📝 Meta (${(draft.meta_description || '').length} chars):`,
    `${draft.meta_description}`,
    ``,
    `🔑 Keywords: ${(draft.keywords || []).join(', ')}`,
    ``,
    `📄 Excerpt:`,
    `${(draft.body_excerpt || '').slice(0, 400)}...`,
    ``,
    `Reply *APPROVE* to publish to Shopify`,
    `Reply *EDIT [your notes]* to regenerate`,
    `Reply *REJECT* to discard`,
  ].join('\n');

  return sendText(phone, body);
}

/**
 * SCENARIO 5 — Cold Lead Digest to sales lead.
 * Fires when I-03 detects warm leads that have gone cold.
 *
 * @param {string} phone     - Sales lead phone (tenant_config.sales_lead_phone)
 * @param {object} segments  - { high: { count, avg_score, ids }, mid: { count, avg_score, ids }, total }
 * @param {object} config    - Tenant config
 */
async function sendColdLeadDigest(phone, segments, config) {
  const lines = [
    `📉 *Cold Lead Alert — ${config.brand_name}*`,
    ``,
    `*${segments.total}* warm leads went cold this week.`,
    ``,
  ];

  if (segments.high && segments.high.count > 0) {
    lines.push(`🔴 *HIGH VALUE* — ${segments.high.count} leads`);
    lines.push(`   Avg score: ${segments.high.avg_score}/100`);
    lines.push(``);
  }
  if (segments.mid && segments.mid.count > 0) {
    lines.push(`🟡 *MID VALUE* — ${segments.mid.count} leads`);
    lines.push(`   Avg score: ${segments.mid.avg_score}/100`);
    lines.push(``);
  }

  lines.push(`Reply:`,
    `*RE-ENGAGE ALL* — launch A-02 for all ${segments.total}`,
    `*RE-ENGAGE HIGH* — high value only`,
    `*RE-ENGAGE MID* — mid value only`,
    `*SHOW LIST* — get the full lead list`);

  return sendText(phone, lines.join('\n'));
}

/**
 * SC-03 — Sales Signal Handoff to sales rep.
 * Fires when SC-03 qualifies a high-intent inbound lead.
 *
 * @param {string} phone   - Sales rep phone
 * @param {object} data    - { name, email, company, intent_summary, suggested_opener, source }
 * @param {object} config  - Tenant config
 */
async function sendSalesHandoff(phone, data, config) {
  const body = [
    `💼 *High-Intent Lead — ${config.brand_name}*`,
    ``,
    `👤 ${data.name} (${data.email})`,
    data.company ? `🏢 ${data.company}` : null,
    `📍 Source: ${data.source || 'inbound'}`,
    ``,
    `Intent:`,
    `${data.intent_summary}`,
    ``,
    `Suggested opener:`,
    `"${data.suggested_opener}"`,
    ``,
    `Reply *ASSIGN* to take this lead`,
    `Reply *EMAIL* to fire email sequence now`,
    `Reply *PASS* to skip`,
  ].filter(Boolean).join('\n');

  return sendText(phone, body);
}

/**
 * Generic ops notification — replaces Slack for all 24 workflows.
 * Level: 'info' | 'warning' | 'error' | 'success'
 *
 * @param {string} phone
 * @param {string} message
 * @param {string} level
 */
async function sendNotify(phone, message, level = 'info') {
  const emoji = { info: 'ℹ️', warning: '⚠️', error: '🚨', success: '✅' };
  const prefix = emoji[level] || 'ℹ️';
  return sendText(phone, `${prefix} ${message}`);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Strip spaces/dashes, ensure E.164 */
function _clean(phone) {
  if (!phone) return '';
  const digits = phone.replace(/[\s\-()]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

module.exports = {
  sendText,
  sendList,
  sendButtons,
  sendLeadAlert,
  sendEmailReplyAlert,
  sendIgEscalation,
  sendSeoApproval,
  sendColdLeadDigest,
  sendSalesHandoff,
  sendNotify,
};
