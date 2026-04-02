'use strict';

/**
 * I-04 — Tax Compliance Report
 *
 * Triggered: monthly 1st at 9 AM (scheduler) or manually.
 * Pulls orders for the previous calendar month from Shopify,
 * computes VAT/tax summaries per jurisdiction, generates a compliance
 * report with GPT-4o-mini, saves to `tax_reports` table, and notifies
 * the finance team via WhatsApp.
 *
 * CRITICAL workflow — runs even when credit balance is zero.
 *
 * Scheduler export : runTaxCompliance(tenantId, config)
 * Webhook export   : handleTaxReport(tenantId, payload, config)
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

async function handleTaxReport(tenantId, payload, config) {
  // Default to previous calendar month
  const now = new Date();
  const year  = payload.year  || (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const month = payload.month || (now.getMonth() === 0 ? 12 : now.getMonth()); // 1-indexed
  const monthStr = String(month).padStart(2, '0');
  const since = `${year}-${monthStr}-01T00:00:00Z`;
  const until = new Date(year, month, 1).toISOString(); // first day of next month

  // ── Pull orders from Shopify ──────────────────────────────
  const shopifyDomain = config.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken  = config.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;

  let orders = [];
  if (shopifyDomain && shopifyToken) {
    try {
      const res = await axios.get(
        `https://${shopifyDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${since}&created_at_max=${until}&limit=250&fields=id,total_price,total_tax,currency,billing_address,financial_status`,
        { headers: { 'X-Shopify-Access-Token': shopifyToken } }
      );
      orders = res.data.orders || [];
    } catch (err) {
      console.error('[I-04] Shopify orders fetch failed:', err.message);
    }
  }

  // ── Also pull from Supabase as fallback ───────────────────
  if (orders.length === 0) {
    const { data } = await sb()
      .from('orders')
      .select('total_price, total_tax, currency, country_code, created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', since)
      .lt('created_at', until)
      .catch(() => ({ data: [] }));
    orders = data || [];
  }

  // ── Aggregate by jurisdiction ─────────────────────────────
  const jurisdictions = {};
  let totalRevenue = 0;
  let totalTax     = 0;

  for (const order of orders) {
    const country = order.billing_address?.country_code || order.country_code || 'UNKNOWN';
    const revenue  = parseFloat(order.total_price || 0);
    const tax      = parseFloat(order.total_tax || 0);

    if (!jurisdictions[country]) {
      jurisdictions[country] = { country, order_count: 0, gross_revenue: 0, tax_collected: 0, currency: order.currency || 'USD' };
    }
    jurisdictions[country].order_count++;
    jurisdictions[country].gross_revenue += revenue;
    jurisdictions[country].tax_collected  += tax;
    totalRevenue += revenue;
    totalTax     += tax;
  }

  const jurisdictionList = Object.values(jurisdictions).map(j => ({
    ...j,
    gross_revenue: +j.gross_revenue.toFixed(2),
    tax_collected: +j.tax_collected.toFixed(2),
    effective_rate: j.gross_revenue > 0 ? +((j.tax_collected / j.gross_revenue) * 100).toFixed(2) : 0,
  }));

  // ── AI compliance commentary ──────────────────────────────
  let commentary = '';
  let filingDeadlines = [];
  if (process.env.OPENAI_API_KEY && jurisdictionList.length > 0) {
    const prompt = `You are a tax compliance advisor. Review this monthly sales tax summary and provide actionable guidance.

Brand: ${config.brand_name}
Period: ${year}-${monthStr}
Total revenue: $${totalRevenue.toFixed(2)} | Total tax collected: $${totalTax.toFixed(2)}

Jurisdiction breakdown:
${jurisdictionList.map(j => `- ${j.country}: ${j.order_count} orders, $${j.gross_revenue} revenue, $${j.tax_collected} tax (${j.effective_rate}%)`).join('\n')}

Return ONLY valid JSON:
{
  "summary": "2-sentence compliance summary",
  "filing_deadlines": ["deadline 1 with jurisdiction", "deadline 2"],
  "anomalies": ["any unusual tax rates or jurisdictions to investigate"],
  "actions_required": ["required actions before filing"],
  "risk_level": "low|medium|high"
}`;

    try {
      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: config.ai_model_standard || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });

      const parsed = JSON.parse(aiRes.data.choices[0].message.content);
      commentary      = parsed.summary;
      filingDeadlines = parsed.filing_deadlines || [];

      // Store enriched data
      jurisdictionList._commentary      = parsed.summary;
      jurisdictionList._filingDeadlines = parsed.filing_deadlines;
      jurisdictionList._anomalies       = parsed.anomalies;
      jurisdictionList._actionsRequired = parsed.actions_required;
      jurisdictionList._riskLevel       = parsed.risk_level;
    } catch (err) {
      console.error('[I-04] AI commentary failed:', err.message);
    }
  }

  // ── Save report ───────────────────────────────────────────
  await sb().from('tax_reports').insert({
    tenant_id:         tenantId,
    period_year:       year,
    period_month:      month,
    total_revenue:     +totalRevenue.toFixed(2),
    total_tax:         +totalTax.toFixed(2),
    order_count:       orders.length,
    jurisdictions:     jurisdictionList,
    commentary,
    filing_deadlines:  filingDeadlines,
    generated_at:      new Date().toISOString(),
  }).catch(() => {});

  // ── Notify finance team ───────────────────────────────────
  const msg = `🧾 *Tax Report — ${year}/${monthStr}*\n` +
    `Revenue: *$${totalRevenue.toFixed(2)}* | Tax: *$${totalTax.toFixed(2)}*\n` +
    `Jurisdictions: ${jurisdictionList.length}\n` +
    (commentary ? `\n${commentary}` : '') +
    (filingDeadlines.length > 0 ? `\n\n📅 Filing deadlines:\n${filingDeadlines.map(d => `• ${d}`).join('\n')}` : '');

  await notify(config, 'tax_compliance', msg, 'warning').catch(() => {});

  return {
    ok:           true,
    workflow:     'I-04',
    period:       `${year}-${monthStr}`,
    order_count:  orders.length,
    total_revenue: +totalRevenue.toFixed(2),
    total_tax:    +totalTax.toFixed(2),
    jurisdictions: jurisdictionList.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner
// ─────────────────────────────────────────────────────────────

async function runTaxCompliance(tenantId, config) {
  await handleTaxReport(tenantId, {}, config);
}

module.exports = { handleTaxReport, runTaxCompliance };
