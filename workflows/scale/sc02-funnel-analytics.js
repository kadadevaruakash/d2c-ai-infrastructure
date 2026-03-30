const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function runFunnelAnalytics(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateStr = sevenDaysAgo.toISOString().split('T')[0];

  const shopifyDomain = tenantConfig.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken = tenantConfig.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;

  // Fetch Shopify 7-day orders and GA4 funnel data in parallel
  const [ordersResult, ga4Result] = await Promise.allSettled([
    axios.get(`https://${shopifyDomain}/admin/api/2024-01/orders.json`, {
      params: {
        created_at_min: sevenDaysAgo.toISOString(),
        status: 'any',
        limit: 250,
        fields: 'id,total_price,source_name,landing_site,referring_site,created_at'
      },
      headers: { 'X-Shopify-Access-Token': shopifyToken }
    }),
    fetchGA4FunnelData(tenantConfig)
  ]);

  const orders = ordersResult.status === 'fulfilled' ? ordersResult.value.data.orders || [] : [];
  const ga4Data = ga4Result.status === 'fulfilled' ? ga4Result.value : null;

  // Calculate conversion metrics
  const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const orderCount = orders.length;
  const sessions = ga4Data?.sessions || 0;
  const productViews = ga4Data?.product_views || 0;
  const cartAdds = ga4Data?.cart_adds || 0;
  const checkoutStarts = ga4Data?.checkout_starts || 0;

  const conversionRate = sessions > 0 ? (orderCount / sessions * 100) : 0;
  const cartAddRate = productViews > 0 ? (cartAdds / productViews * 100) : 0;
  const checkoutRate = cartAdds > 0 ? (checkoutStarts / cartAdds * 100) : 0;
  const purchaseRate = checkoutStarts > 0 ? (orderCount / checkoutStarts * 100) : 0;

  // AI analysis
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are an e-commerce funnel analyst. Identify drop-off points and optimization opportunities. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Period: Last 7 days\nSessions: ${sessions}\nProduct Views: ${productViews}\nCart Adds: ${cartAdds}\nCheckout Starts: ${checkoutStarts}\nOrders: ${orderCount}\nRevenue: $${totalRevenue.toFixed(2)}\nOverall Conversion Rate: ${conversionRate.toFixed(2)}%\n\nReturn JSON:\n{"biggest_drop_off": "string", "recommendations": ["string"], "health_score": number (1-10), "priority_fix": "string"}`
    }
  ], 'gpt-4o-mini');

  const analysis = parseAiJson(aiRaw, {
    biggest_drop_off: 'Unable to determine',
    recommendations: ['Review funnel data manually'],
    health_score: 5,
    priority_fix: 'Review checkout flow'
  });

  // Store analytics
  const reportId = 'FNL-' + Date.now();
  await sb.from('funnel_analytics').insert({
    report_id: reportId,
    tenant_id: tenantId,
    period_start: sevenDaysAgo.toISOString(),
    period_end: now.toISOString(),
    sessions,
    product_views: productViews,
    cart_adds: cartAdds,
    checkout_starts: checkoutStarts,
    orders: orderCount,
    revenue: totalRevenue,
    conversion_rate: conversionRate,
    cart_add_rate: cartAddRate,
    checkout_rate: checkoutRate,
    purchase_rate: purchaseRate,
    health_score: analysis.health_score,
    biggest_drop_off: analysis.biggest_drop_off,
    recommendations: JSON.stringify(analysis.recommendations),
    created_at: now.toISOString()
  });

  // Push to Google Sheets if configured
  if (tenantConfig.google_sheets_funnel_id) {
    console.log(`[Google Sheets] Would append funnel data to ${tenantConfig.google_sheets_funnel_id}`);
  }

  await notify(tenantConfig, 'slack_marketing_channel', {
    text: `📊 7-DAY FUNNEL REPORT\n\nSessions: ${sessions.toLocaleString()}\nConversion Rate: ${conversionRate.toFixed(2)}%\nOrders: ${orderCount}\nRevenue: $${totalRevenue.toFixed(2)}\nHealth Score: ${analysis.health_score}/10\n\nBiggest Drop-off: ${analysis.biggest_drop_off}\nPriority Fix: ${analysis.priority_fix}`
  });

  return { report_id: reportId, conversion_rate: conversionRate, health_score: analysis.health_score };
}

async function fetchGA4FunnelData(tenantConfig) {
  // GA4 Data API integration placeholder
  // Requires googleapis + service account setup
  // Returns mock structure if not configured
  const ga4PropertyId = tenantConfig.ga4_property_id || process.env.GA4_PROPERTY_ID;
  if (!ga4PropertyId) {
    return { sessions: 0, product_views: 0, cart_adds: 0, checkout_starts: 0 };
  }

  // TODO: implement with googleapis when credential is configured
  console.log(`[GA4] Would fetch funnel data for property ${ga4PropertyId}`);
  return { sessions: 0, product_views: 0, cart_adds: 0, checkout_starts: 0 };
}

module.exports = { runFunnelAnalytics };
