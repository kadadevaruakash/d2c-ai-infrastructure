'use strict';

/**
 * Brevo Webhook Handler
 *
 * Handles email lifecycle events from Brevo (delivered, opened, clicked, replied, bounced).
 *
 * Extended for SCENARIO 2:
 *   When a replied event arrives for workflow_id=A-02 (cold email),
 *   it calls A-02's handleEmailReply() which classifies the reply intent
 *   and sends a WhatsApp alert to the sales rep if actionable.
 *
 * Brevo webhook URL to configure in Brevo dashboard:
 *   POST https://yourdomain.com/api/webhook/brevo
 *
 * Brevo sends events with this shape:
 *   {
 *     event: 'opened' | 'clicked' | 'delivered' | 'replied' | 'hardBounce' | 'softBounce',
 *     email: 'recipient@example.com',
 *     message-id: '<...>',
 *     subject: '...',
 *     tags: { tenant_id: '...', workflow_id: 'A-02', ... },
 *     reply_text: '...' (only on replied events — requires Brevo inbound parsing)
 *   }
 *
 * Note: Brevo's inbound email parsing (reply capture) requires setting up
 * an inbound domain in Brevo and pointing your reply-to MX records there.
 * See: https://developers.brevo.com/docs/inbound-parsing
 */

const express       = require('express');
const router        = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

const EVENT_MAP = {
  delivered:  'delivered',
  opened:     'opened',
  clicks:     'clicked',
  hardBounce: 'bounced',
  softBounce: 'bounced',
  replied:    'replied',
};

// ─────────────────────────────────────────────────────────────
// POST /api/webhook/brevo
// ─────────────────────────────────────────────────────────────

router.post('/brevo', async (req, res) => {
  // Acknowledge immediately — Brevo retries on non-200
  res.json({ received: true });

  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const ev of events) {
    const eventType = EVENT_MAP[ev.event];
    if (!eventType) continue;

    // Resolve tenant_id from tags (set when email was sent)
    const tenantId = ev.tags?.tenant_id || ev['X-Mailin-custom']?.tenant_id;
    if (!tenantId) continue;

    const workflowId = ev.tags?.workflow_id || null;

    // ── Log event ──────────────────────────────────────────
    await sb().from('email_events').insert({
      tenant_id:       tenantId,
      workflow_id:     workflowId,
      message_id:      ev['message-id'] || ev.message_id || null,
      event_type:      eventType,
      recipient_email: ev.email,
      metadata:        { subject: ev.subject, link: ev.link },
    }).catch(() => {});

    // ── SCENARIO 2: Route A-02 replies to WhatsApp ─────────
    if (eventType === 'replied' && workflowId === 'A-02') {
      await _handleA02Reply(tenantId, ev).catch(err =>
        console.error('[brevo-webhooks] A-02 reply handler error:', err.message)
      );
    }

    // ── Handle bounces — update lead status ───────────────
    if (eventType === 'bounced') {
      await sb().from('leads')
        .update({ status: 'bounced' })
        .eq('tenant_id', tenantId)
        .eq('email', ev.email)
        .catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────
// A-02 reply handler
// ─────────────────────────────────────────────────────────────

async function _handleA02Reply(tenantId, ev) {
  // Fetch tenant config for phone numbers
  const { data: config } = await sb()
    .from('tenant_config')
    .select('*, tenants!inner(id, slug)')
    .eq('tenants.id', tenantId)
    .single()
    .catch(() => ({ data: null }));

  if (!config) {
    console.warn('[brevo-webhooks] No tenant config found for A-02 reply, tenant_id:', tenantId);
    return;
  }

  const { handleEmailReply } = require('../workflows/acquire/a02-cold-email');

  await handleEmailReply(tenantId, {
    message_id:       ev['message-id'] || ev.message_id || null,
    prospect_email:   ev.email,
    reply_text:       ev.reply_text || ev.text || ev.body || 'No reply text captured',
    original_subject: ev.subject || '',
  }, config);
}

// ─────────────────────────────────────────────────────────────
// Email stats aggregation (unchanged)
// ─────────────────────────────────────────────────────────────

async function getEmailStats(tenantId) {
  const { data } = await sb()
    .from('email_events')
    .select('event_type, workflow_id')
    .eq('tenant_id', tenantId);

  if (!data || data.length === 0) {
    return {
      summary: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, open_rate: 0, click_rate: 0, reply_rate: 0 },
      by_workflow: [],
    };
  }

  const count    = (type) => data.filter(e => e.event_type === type).length;
  const delivered = count('delivered');
  const opened    = count('opened');
  const clicked   = count('clicked');
  const replied   = count('replied');

  const wfMap = {};
  data.forEach(e => {
    if (!e.workflow_id) return;
    wfMap[e.workflow_id] = wfMap[e.workflow_id] || { workflow_id: e.workflow_id, sent: 0, opened: 0, clicked: 0 };
    if (e.event_type === 'delivered') wfMap[e.workflow_id].sent++;
    if (e.event_type === 'opened')    wfMap[e.workflow_id].opened++;
    if (e.event_type === 'clicked')   wfMap[e.workflow_id].clicked++;
  });

  return {
    summary: {
      sent: delivered, delivered, opened, clicked, replied,
      open_rate:  delivered > 0 ? +((opened  / delivered) * 100).toFixed(1) : 0,
      click_rate: delivered > 0 ? +((clicked / delivered) * 100).toFixed(1) : 0,
      reply_rate: delivered > 0 ? +((replied / delivered) * 100).toFixed(1) : 0,
    },
    by_workflow: Object.values(wfMap).map(w => ({
      ...w,
      open_rate: w.sent > 0 ? +((w.opened / w.sent) * 100).toFixed(1) : 0,
    })),
  };
}

module.exports = { brevoWebhookRouter: router, getEmailStats };
