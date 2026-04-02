'use strict';

/**
 * SC-02 — Funnel Analytics
 *
 * Triggered: daily 8 AM (scheduler) or manually via webhook.
 * Computes full-funnel conversion metrics across Shopify and internal tables:
 *   Sessions → Add-to-cart → Checkout initiated → Orders (conversion funnel)
 *   + email funnel: sent → opened → clicked → replied
 *   + WhatsApp support resolution rate
 *
 * Generates AI insight commentary, saves to `funnel_snapshots` table,
 * and sends a digest to the strategy team.
 *
 * Scheduler export : runFunnelAnalytics(tenantId, config)
 * Webhook export   : handleFunnelAnalytics(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Core handler
// ─────────────────────────────────────────────────────────────

async function handleFunnelAnalytics(tenantId, payload, config) {
  const days  = payload.days || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // ── Pull metrics from all sources ────────────────────────
  const [
    ordersRes, cartsRes, checkoutsRes,
    emailRes, supportRes, leadsRes,
  ] = await Promise.all([
    sb().from('orders').select('id, total_price, created_at').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('cart_recoveries').select('id, status, cart_value').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('checkout_events').select('id').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('email_events').select('event_type').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('support_tickets').select('id, status').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('leads').select('id, category').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
  ]);

  const orders    = ordersRes.data    || [];
  const carts     = cartsRes.data     || [];
  const checkouts = checkoutsRes.data || [];
  const emails    = emailRes.data     || [];
  const tickets   = supportRes.data   || [];
  const leads     = leadsRes.data     || [];

  // ── Compute funnel metrics ────────────────────────────────
  const totalRevenue   = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const cartCount      = carts.length;
  const cartRecovered  = carts.filter(c => c.status === 'recovered').length;
  const checkoutCount  = checkouts.length;
  const orderCount     = orders.length;

  // Email funnel
  const emailSent      = emails.filter(e => e.event_type === 'sent').length;
  const emailOpened    = emails.filter(e => e.event_type === 'opened').length;
  const emailClicked   = emails.filter(e => e.event_type === 'clicked').length;
  const emailReplied   = emails.filter(e => e.event_type === 'replied').length;

  // Support
  const ticketsTotal   = tickets.length;
  const ticketsClosed  = tickets.filter(t => t.status === 'closed').length;
  const resolutionRate = ticketsTotal > 0 ? Math.round((ticketsClosed / ticketsTotal) * 100) : 100;

  // Leads
  const hotLeads       = leads.filter(l => l.category === 'hot').length;
  const leadTotal      = leads.length;

  const funnel = {
    period_days:     days,
    // Purchase funnel
    carts_created:   cartCount,
    checkouts_started: checkoutCount,
    orders_placed:   orderCount,
    total_revenue:   +totalRevenue.toFixed(2),
    cart_recovery_rate: cartCount > 0 ? +((cartRecovered / cartCount) * 100).toFixed(1) : 0,
    checkout_to_order: checkoutCount > 0 ? +((orderCount / checkoutCount) * 100).toFixed(1) : 0,
    // Email
    email_sent:      emailSent,
    email_open_rate: emailSent > 0 ? +((emailOpened / emailSent) * 100).toFixed(1) : 0,
    email_click_rate: emailSent > 0 ? +((emailClicked / emailSent) * 100).toFixed(1) : 0,
    email_reply_rate: emailSent > 0 ? +((emailReplied / emailSent) * 100).toFixed(1) : 0,
    // Support
    tickets_total:   ticketsTotal,
    resolution_rate: resolutionRate,
    // Leads
    leads_total:     leadTotal,
    hot_leads:       hotLeads,
    lead_to_order:   leadTotal > 0 ? +((orderCount / leadTotal) * 100).toFixed(1) : 0,
  };

  // ── AI commentary ─────────────────────────────────────────
  let headline = '';
  let insights = [];
  if (process.env.OPENAI_API_KEY) {
    const roas_threshold   = config.roas_alert_threshold  || 3;
    const margin_threshold = config.margin_alert_threshold || 40;

    const prompt = `You are a growth analyst for ${config.brand_name}. Analyse these ${days}-day funnel metrics.

${JSON.stringify(funnel, null, 2)}

ROAS target: ${roas_threshold}x | Margin target: ${margin_threshold}%

Return ONLY valid JSON:
{
  "headline": "one-line metric summary (e.g. Checkout rate up 8% — email click-through leading)",
  "top_insight": "most important single insight",
  "bottlenecks": ["biggest funnel drop-off 1", "biggest funnel drop-off 2"],
  "wins": ["top positive signal"],
  "actions": ["prioritised action 1", "prioritised action 2", "prioritised action 3"]
}`;

    try {
      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: config.ai_model_standard || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });

      const parsed = JSON.parse(aiRes.data.choices[0].message.content);
      headline = parsed.headline;
      insights = parsed.actions || [];
      funnel.headline    = parsed.headline;
      funnel.top_insight = parsed.top_insight;
      funnel.bottlenecks = parsed.bottlenecks;
      funnel.wins        = parsed.wins;
      funnel.actions     = parsed.actions;
    } catch (err) {
      console.error('[SC-02] AI insights failed:', err.message);
    }
  }

  // ── Save snapshot ─────────────────────────────────────────
  await sb().from('funnel_snapshots').insert({
    tenant_id:    tenantId,
    period_days:  days,
    metrics:      funnel,
    snapshot_at:  new Date().toISOString(),
  }).catch(() => {});

  // ── Notify strategy team ──────────────────────────────────
  const msg = `📊 *${days}-Day Funnel Report*\n` +
    `Revenue: *$${funnel.total_revenue}* | Orders: *${funnel.orders_placed}*\n` +
    `Cart recovery: *${funnel.cart_recovery_rate}%* | Email open: *${funnel.email_open_rate}%*\n` +
    `Support resolution: *${funnel.resolution_rate}%*\n` +
    (headline ? `\n${headline}` : '') +
    (insights.length > 0 ? `\n\nActions:\n${insights.slice(0, 3).map(a => `• ${a}`).join('\n')}` : '');

  const hasIssues = funnel.cart_recovery_rate < 10 || funnel.email_open_rate < 15;
  await notify(config, 'analytics', msg, hasIssues ? 'warning' : 'info').catch(() => {});

  return { ok: true, workflow: 'SC-02', period_days: days, metrics: funnel };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner
// ─────────────────────────────────────────────────────────────

async function runFunnelAnalytics(tenantId, config) {
  await handleFunnelAnalytics(tenantId, { days: 7 }, config);
}

module.exports = { handleFunnelAnalytics, runFunnelAnalytics };
