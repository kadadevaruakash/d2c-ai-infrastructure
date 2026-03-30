const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function runRevenueReports(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  const startOfDay = `${dateStr}T00:00:00Z`;
  const endOfDay = `${dateStr}T23:59:59Z`;

  // Fetch Shopify orders for yesterday
  const shopifyDomain = tenantConfig.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken = tenantConfig.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;

  let orders = [];
  let adSpend = 0;

  try {
    const ordersRes = await axios.get(
      `https://${shopifyDomain}/admin/api/2024-01/orders.json`,
      {
        params: {
          created_at_min: startOfDay,
          created_at_max: endOfDay,
          status: 'any',
          limit: 250
        },
        headers: { 'X-Shopify-Access-Token': shopifyToken }
      }
    );
    orders = ordersRes.data.orders || [];
  } catch (err) {
    console.error('Shopify orders fetch failed:', err.message);
  }

  // Try to get Meta ad spend from DB (populated by Meta webhook or manual entry)
  try {
    const { data: adData } = await sb
      .from('ad_spend')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('date', dateStr)
      .eq('platform', 'meta')
      .limit(1);
    adSpend = adData?.[0]?.spend || 0;
  } catch (err) {
    console.error('Ad spend fetch failed:', err.message);
  }

  // Calculate metrics
  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const orderCount = orders.length;
  const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;
  const roas = adSpend > 0 ? totalRevenue / adSpend : null;
  const grossMarginRate = tenantConfig.gross_margin_rate || 0.45;
  const grossProfit = totalRevenue * grossMarginRate;
  const netProfit = grossProfit - adSpend;

  // AI analysis
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a D2C revenue analyst. Analyze daily metrics and identify anomalies or opportunities. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Date: ${dateStr}\nRevenue: $${totalRevenue.toFixed(2)}\nOrders: ${orderCount}\nAOV: $${avgOrderValue.toFixed(2)}\nAd Spend: $${adSpend}\nROAS: ${roas ? roas.toFixed(2) : 'N/A'}\nNet Profit: $${netProfit.toFixed(2)}\n\nReturn JSON:\n{"anomalies": ["string"], "insights": ["string"], "recommendations": ["string"], "performance": "excellent|good|average|poor"}`
    }
  ], 'gpt-4o-mini');

  const analysis = parseAiJson(aiRaw, {
    anomalies: [],
    insights: [`Revenue: $${totalRevenue.toFixed(2)} from ${orderCount} orders`],
    recommendations: [],
    performance: 'average'
  });

  // Store report
  const reportId = 'RPT-' + Date.now();
  await sb.from('revenue_reports').insert({
    report_id: reportId,
    tenant_id: tenantId,
    date: dateStr,
    revenue: totalRevenue,
    order_count: orderCount,
    avg_order_value: avgOrderValue,
    ad_spend: adSpend,
    roas,
    gross_profit: grossProfit,
    net_profit: netProfit,
    anomalies: JSON.stringify(analysis.anomalies),
    insights: JSON.stringify(analysis.insights),
    performance: analysis.performance,
    created_at: new Date().toISOString()
  });

  // Push to Google Sheets if configured
  if (tenantConfig.google_sheets_revenue_id) {
    await appendToGoogleSheets(tenantConfig, [
      dateStr, totalRevenue.toFixed(2), orderCount, avgOrderValue.toFixed(2),
      adSpend, roas?.toFixed(2) || '', netProfit.toFixed(2), analysis.performance
    ]);
  }

  const anomalyText = analysis.anomalies.length > 0
    ? `\n⚠️ Anomalies: ${analysis.anomalies.join(', ')}`
    : '';

  await notify(tenantConfig, 'slack_finance_channel', {
    text: `📊 DAILY P&L REPORT — ${dateStr}\n\nRevenue: $${totalRevenue.toFixed(2)}\nOrders: ${orderCount}\nAOV: $${avgOrderValue.toFixed(2)}\nAd Spend: $${adSpend}\nROAS: ${roas ? roas.toFixed(2) + 'x' : 'N/A'}\nNet Profit: $${netProfit.toFixed(2)}\nPerformance: ${analysis.performance.toUpperCase()}${anomalyText}`
  });

  if (analysis.anomalies.length > 0) {
    await notify(tenantConfig, 'email_finance', {
      subject: `⚠️ Revenue Anomalies Detected — ${dateStr}`,
      text: `Anomalies detected in daily revenue report:\n\n${analysis.anomalies.join('\n')}\n\nRecommendations:\n${analysis.recommendations.join('\n')}`
    });
  }

  return { report_id: reportId, revenue: totalRevenue, orders: orderCount, performance: analysis.performance };
}

async function appendToGoogleSheets(tenantConfig, rowData) {
  // Google Sheets append — requires googleapis setup
  // Placeholder: log intent, implement when googleapis credential is configured
  console.log(`[Google Sheets] Would append to ${tenantConfig.google_sheets_revenue_id}:`, rowData);
}

module.exports = { runRevenueReports };
