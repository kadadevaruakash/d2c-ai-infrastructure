'use strict';

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

const EVENT_MAP = { delivered: 'delivered', opened: 'opened', clicks: 'clicked', hardBounce: 'bounced', softBounce: 'bounced', replied: 'replied' };

// POST /api/webhook/brevo
router.post('/brevo', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const ev of events) {
    const eventType = EVENT_MAP[ev.event];
    if (!eventType) continue;
    const tenantId = ev.tags?.tenant_id || ev['X-Mailin-custom']?.tenant_id;
    if (!tenantId) continue;
    await sb().from('email_events').insert({
      tenant_id:       tenantId,
      workflow_id:     ev.tags?.workflow_id || null,
      message_id:      ev['message-id'] || ev.message_id || null,
      event_type:      eventType,
      recipient_email: ev.email,
      metadata:        { subject: ev.subject, link: ev.link },
    }).catch(() => {});
  }
  res.json({ received: true });
});

async function getEmailStats(tenantId) {
  const { data } = await sb().from('email_events').select('event_type, workflow_id').eq('tenant_id', tenantId);
  if (!data || data.length === 0) {
    return { summary: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, open_rate: 0, click_rate: 0, reply_rate: 0 }, by_workflow: [] };
  }

  const count = (type) => data.filter(e => e.event_type === type).length;
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
      ...w, open_rate: w.sent > 0 ? +((w.opened / w.sent) * 100).toFixed(1) : 0,
    })),
  };
}

module.exports = { brevoWebhookRouter: router, getEmailStats };
