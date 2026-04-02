'use strict';

/**
 * I-02 — Revenue Reports
 *
 * Triggered: daily 8 AM (scheduler) or manually via webhook.
 * Pulls Shopify orders + loyalty + cart recovery data for the last 30 days,
 * runs GPT-4o-mini to generate an executive revenue narrative,
 * saves report to `revenue_reports` table, and sends digest via WhatsApp/notification.
 *
 * Scheduler export : runRevenueReports(tenantId, config)
 * Webhook export   : handleRevenueReport(tenantId, payload, config)
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

async function handleRevenueReport(tenantId, payload, config) {
  const period = payload.period || 'daily'; // 'daily' | 'weekly' | 'monthly'
  const days   = { daily: 1, weekly: 7, monthly: 30 }[period] || 1;
  const since  = new Date(Date.now() - days * 86400000).toISOString();

  // ── Pull metrics from Supabase ────────────────────────────
  const [ordersRes, cartsRes, loyaltyRes] = await Promise.all([
    sb().from('orders').select('total_price, created_at, customer_id').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('cart_recoveries').select('status, cart_value, recovery_value, created_at').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
    sb().from('loyalty_transactions').select('points, event_type, created_at').eq('tenant_id', tenantId).gte('created_at', since).catch(() => ({ data: [] })),
  ]);

  const orders    = ordersRes.data || [];
  const carts     = cartsRes.data  || [];
  const loyalty   = loyaltyRes.data || [];

  const totalRevenue   = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const orderCount     = orders.length;
  const aov            = orderCount > 0 ? totalRevenue / orderCount : 0;
  const recovered      = carts.filter(c => c.status === 'recovered');
  const recoveryRev    = recovered.reduce((s, c) => s + parseFloat(c.recovery_value || 0), 0);
  const loyaltyPts     = loyalty.reduce((s, l) => s + (l.points || 0), 0);
  const uniqueCustomers = new Set(orders.map(o => o.customer_id)).size;

  const metrics = {
    period,
    total_revenue: totalRevenue.toFixed(2),
    order_count:   orderCount,
    aov:           aov.toFixed(2),
    unique_customers: uniqueCustomers,
    recovery_revenue: recoveryRev.toFixed(2),
    carts_recovered:  recovered.length,
    loyalty_points_issued: loyaltyPts,
  };

  // ── AI narrative ──────────────────────────────────────────
  let narrative = '';
  if (process.env.OPENAI_API_KEY) {
    const roas_threshold  = config.roas_alert_threshold  || 3;
    const margin_threshold = config.margin_alert_threshold || 40;

    const prompt = `You are a revenue analyst for ${config.brand_name}. Write a concise ${period} revenue report.

Metrics:
- Total revenue: $${metrics.total_revenue}
- Orders: ${metrics.order_count} | AOV: $${metrics.aov}
- Unique customers: ${metrics.unique_customers}
- Cart recovery revenue: $${metrics.recovery_revenue} (${metrics.carts_recovered} carts)
- Loyalty points issued: ${metrics.loyalty_points_issued}
- ROAS threshold: ${roas_threshold}x | Margin threshold: ${margin_threshold}%

Return ONLY valid JSON:
{
  "headline": "one-line summary (e.g. Revenue up 12% DoD — cart recovery leading)",
  "narrative": "2-3 sentence executive commentary",
  "alerts": ["any metric that needs attention"],
  "bright_spots": ["top 1-2 positive signals"],
  "recommendations": ["top 2 actions for tomorrow"]
}`;

    try {
      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: config.ai_model_standard || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });

      const parsed = JSON.parse(aiRes.data.choices[0].message.content);
      metrics.headline        = parsed.headline;
      metrics.narrative       = parsed.narrative;
      metrics.alerts          = parsed.alerts;
      metrics.bright_spots    = parsed.bright_spots;
      metrics.recommendations = parsed.recommendations;
      narrative = parsed.headline;
    } catch (err) {
      console.error('[I-02] AI narrative failed:', err.message);
    }
  }

  // ── Save report ───────────────────────────────────────────
  await sb().from('revenue_reports').insert({
    tenant_id:  tenantId,
    period,
    metrics,
    generated_at: new Date().toISOString(),
  }).catch(() => {});

  // ── Notify ────────────────────────────────────────────────
  const msg = `📈 *${period.charAt(0).toUpperCase() + period.slice(1)} Revenue Report*\n` +
    `Revenue: *$${metrics.total_revenue}* | Orders: *${metrics.order_count}* | AOV: *$${metrics.aov}*\n` +
    `Cart recovery: *$${metrics.recovery_revenue}*\n` +
    (narrative ? `\n${narrative}` : '');

  const hasAlerts = (metrics.alerts || []).length > 0;
  await notify(config, 'revenue_reports', msg, hasAlerts ? 'warning' : 'info').catch(() => {});

  return { ok: true, workflow: 'I-02', period, metrics };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner
// ─────────────────────────────────────────────────────────────

async function runRevenueReports(tenantId, config) {
  await handleRevenueReport(tenantId, { period: 'daily' }, config);
}

module.exports = { handleRevenueReport, runRevenueReports };
