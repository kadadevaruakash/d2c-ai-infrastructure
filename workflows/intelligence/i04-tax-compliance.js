const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function runTaxCompliance(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Get last month date range
  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  const periodLabel = `${lastMonthStart.getFullYear()}-${String(lastMonthStart.getMonth() + 1).padStart(2, '0')}`;

  // Fetch Shopify orders for last month
  const shopifyDomain = tenantConfig.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken = tenantConfig.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;

  let orders = [];
  try {
    const res = await axios.get(
      `https://${shopifyDomain}/admin/api/2024-01/orders.json`,
      {
        params: {
          created_at_min: lastMonthStart.toISOString(),
          created_at_max: lastMonthEnd.toISOString(),
          status: 'any',
          limit: 250,
          fields: 'id,total_price,total_tax,billing_address,shipping_address,line_items,financial_status'
        },
        headers: { 'X-Shopify-Access-Token': shopifyToken }
      }
    );
    orders = res.data.orders || [];
  } catch (err) {
    console.error('Shopify orders fetch failed:', err.message);
  }

  // Calculate tax by jurisdiction
  const taxByJurisdiction = {};
  let totalRevenue = 0;
  let totalTax = 0;

  for (const order of orders) {
    if (order.financial_status === 'refunded') continue;
    const jurisdiction = order.shipping_address?.province_code || order.billing_address?.province_code || 'UNKNOWN';
    const country = order.shipping_address?.country_code || order.billing_address?.country_code || 'US';
    const key = `${country}-${jurisdiction}`;

    if (!taxByJurisdiction[key]) {
      taxByJurisdiction[key] = { country, jurisdiction, revenue: 0, tax_collected: 0, order_count: 0 };
    }
    taxByJurisdiction[key].revenue += parseFloat(order.total_price || 0);
    taxByJurisdiction[key].tax_collected += parseFloat(order.total_tax || 0);
    taxByJurisdiction[key].order_count++;
    totalRevenue += parseFloat(order.total_price || 0);
    totalTax += parseFloat(order.total_tax || 0);
  }

  const jurisdictionList = Object.values(taxByJurisdiction);

  // Store tax report
  const reportId = 'TAX-' + Date.now();
  await sb.from('tax_reports').insert({
    report_id: reportId,
    tenant_id: tenantId,
    period: periodLabel,
    total_revenue: totalRevenue,
    total_tax_collected: totalTax,
    jurisdictions: JSON.stringify(jurisdictionList),
    order_count: orders.length,
    status: 'generated',
    created_at: new Date().toISOString()
  });

  // Push to Google Sheets if configured
  if (tenantConfig.google_sheets_tax_id) {
    console.log(`[Google Sheets] Would append tax data to ${tenantConfig.google_sheets_tax_id}`);
  }

  // Email finance team
  const jurisdictionSummary = jurisdictionList
    .sort((a, b) => b.tax_collected - a.tax_collected)
    .slice(0, 10)
    .map(j => `${j.country}-${j.jurisdiction}: $${j.tax_collected.toFixed(2)} tax on $${j.revenue.toFixed(2)} revenue`)
    .join('\n');

  await notify(tenantConfig, 'email_finance', {
    subject: `📊 Monthly Tax Report — ${periodLabel}`,
    text: `Tax Compliance Report for ${periodLabel}\n\nTotal Revenue: $${totalRevenue.toFixed(2)}\nTotal Tax Collected: $${totalTax.toFixed(2)}\nOrders: ${orders.length}\n\nTop Jurisdictions:\n${jurisdictionSummary}\n\nFull report available in Supabase: Report ID ${reportId}`
  });

  await notify(tenantConfig, 'slack_finance_channel', {
    text: `🧾 TAX REPORT GENERATED — ${periodLabel}\n\nTotal Revenue: $${totalRevenue.toFixed(2)}\nTotal Tax: $${totalTax.toFixed(2)}\nJurisdictions: ${jurisdictionList.length}\nReport ID: ${reportId}\n\nFull report sent to finance team.`
  });

  return { report_id: reportId, period: periodLabel, total_revenue: totalRevenue, total_tax: totalTax, jurisdictions: jurisdictionList.length };
}

module.exports = { runTaxCompliance };
