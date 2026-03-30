const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { upsertCustomer } = require('../../shared/customer');
const { sendWelcomeEmail } = require('../../shared/email');
const { notify } = require('../../shared/notification');

async function handleOrderCreated(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const order = payload;

  const customerId = order.customer?.id;
  const customerEmail = order.customer?.email || order.email;
  const customerPhone = order.customer?.phone || order.shipping_address?.phone;
  const firstName = order.customer?.first_name || 'there';
  const ordersCount = order.customer?.orders_count || 1;
  const totalSpent = parseFloat(order.customer?.total_spent || order.total_price || 0);
  const orderValue = parseFloat(order.total_price || 0);
  const items = (order.line_items || []).map(i => i.title);

  // Get customer purchase history
  const { data: historyData } = await sb
    .from('orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', String(customerId))
    .order('created_at', { ascending: false })
    .limit(10);

  const history = historyData || [];

  // AI RFM segmentation
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a CRM specialist. Segment the customer using RFM analysis and determine the best follow-up action. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Customer: ${firstName}\nOrders Count: ${ordersCount}\nTotal Spent: $${totalSpent}\nLatest Order: $${orderValue}\nItems: ${items.join(', ')}\nOrder History: ${history.length} orders\n\nReturn JSON:\n{"rfm_segment": "new|returning|loyal|vip|at_risk", "follow_up": "welcome|thank_you|upsell|loyalty_invite", "message_tone": "warm|excited|premium", "product_recommendations": ["string"], "next_touchpoint_days": number}`
    }
  ], 'gpt-4o-mini');

  const segmentation = parseAiJson(aiRaw, {
    rfm_segment: ordersCount === 1 ? 'new' : 'returning',
    follow_up: ordersCount === 1 ? 'welcome' : 'thank_you',
    message_tone: 'warm',
    product_recommendations: [],
    next_touchpoint_days: 7
  });

  // Log order
  await sb.from('orders').insert({
    tenant_id: tenantId,
    order_id: String(order.id),
    customer_id: String(customerId),
    customer_email: customerEmail,
    order_value: orderValue,
    items: JSON.stringify(items),
    shopify_order_number: order.order_number,
    created_at: order.created_at || new Date().toISOString()
  }).onConflict('order_id').ignore();

  // Upsert customer
  await upsertCustomer(tenantId, {
    customer_id: String(customerId),
    email: customerEmail,
    phone: customerPhone || null,
    first_name: firstName,
    last_name: order.customer?.last_name || null,
    orders_count: ordersCount,
    total_spent: totalSpent,
    rfm_segment: segmentation.rfm_segment,
    last_order_at: order.created_at || new Date().toISOString()
  });

  // Send welcome/thank you email
  await sendWelcomeEmail(tenantConfig, {
    to: customerEmail,
    first_name: firstName,
    order_id: order.order_number || order.id,
    order_value: orderValue,
    items,
    follow_up_type: segmentation.follow_up,
    tone: segmentation.message_tone,
    product_recommendations: segmentation.product_recommendations
  });

  await notify(tenantConfig, 'slack_cx_channel', {
    text: `🛍️ NEW ORDER — CRM UPDATED\n\nCustomer: ${firstName} (${customerEmail})\nOrder Value: $${orderValue}\nSegment: ${segmentation.rfm_segment}\nFollow-up: ${segmentation.follow_up}\nNext Touchpoint: ${segmentation.next_touchpoint_days} days`
  });

  return {
    customer_id: String(customerId),
    rfm_segment: segmentation.rfm_segment,
    follow_up: segmentation.follow_up
  };
}

module.exports = { handleOrderCreated };
