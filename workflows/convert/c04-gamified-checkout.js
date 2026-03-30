const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function handleGamifiedCheckout(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const checkout = payload;

  const cartValue = parseFloat(checkout.total_price || 0);
  const itemCount = (checkout.line_items || []).length;

  let customerType = 'new';
  if (checkout.customer?.orders_count > 5) customerType = 'vip';
  else if (checkout.customer?.orders_count > 0) customerType = 'returning';

  const freeShippingThreshold = tenantConfig.free_shipping_threshold || 75;

  // AI gamification strategy
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a gamification designer for e-commerce. Determine gamification element: spin_wheel (cart > $75), progress_bar (always), mystery_box (first-time). Discounts must be profitable. VIP gets better odds. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Cart value: $${cartValue}\nCustomer: ${customerType}\nItems: ${itemCount}\nFree shipping threshold: $${freeShippingThreshold}\n\nReturn JSON:\n{"element": "spin_wheel|progress_bar|mystery_box", "discount": "5%|10%|15%|free_shipping", "probability": number, "message": "string"}`
    }
  ], 'gpt-4o-mini');

  const strategy = parseAiJson(aiRaw, {
    element: cartValue > freeShippingThreshold ? 'spin_wheel' : 'progress_bar',
    discount: customerType === 'vip' ? '15%' : '10%',
    probability: customerType === 'vip' ? 0.8 : 0.5,
    message: 'Spin to win a discount!'
  });

  const discountCode = 'SPIN' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const discountStr = strategy.discount || '10%';
  const isFreeShipping = discountStr === 'free_shipping';
  const discountPercent = isFreeShipping ? 100 : parseFloat(discountStr.replace('%', '')) || 10;

  const progressPercent = Math.min(100, (cartValue / freeShippingThreshold) * 100);
  const remainingForFreeShipping = Math.max(0, freeShippingThreshold - cartValue);

  // Create Shopify price rule
  const shopifyDomain = tenantConfig.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken = tenantConfig.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;

  const priceRuleRes = await axios.post(
    `https://${shopifyDomain}/admin/api/2024-01/price_rules.json`,
    {
      price_rule: {
        title: discountCode,
        target_type: isFreeShipping ? 'shipping_line' : 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: isFreeShipping ? 'percentage' : 'percentage',
        value: `-${discountPercent}.0`,
        customer_selection: 'all',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        usage_limit: 1,
        once_per_customer: true
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      }
    }
  );

  const priceRuleId = priceRuleRes.data.price_rule.id;

  // Create discount code under price rule
  await axios.post(
    `https://${shopifyDomain}/admin/api/2024-01/price_rules/${priceRuleId}/discount_codes.json`,
    { discount_code: { code: discountCode } },
    {
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      }
    }
  );

  const engagementScore = cartValue > 100 ? 10 : cartValue > 50 ? 7 : 5;
  const checkoutId = checkout.token || checkout.id;

  await sb.from('checkout_gamification').insert({
    tenant_id: tenantId,
    checkout_id: checkoutId,
    gamification_type: strategy.element,
    discount_code: discountCode,
    discount_value: strategy.discount,
    price_rule_id: priceRuleId,
    engagement_score: engagementScore,
    status: 'active',
    created_at: new Date().toISOString()
  });

  await notify(tenantConfig, 'slack_checkout_channel', {
    text: `🎮 GAMIFICATION ACTIVATED\n\nCheckout: ${checkoutId}\nType: ${strategy.element}\nDiscount: ${discountCode} (${strategy.discount})\nEngagement Score: ${engagementScore}/10\nProgress: ${progressPercent.toFixed(0)}% to free shipping\n$${remainingForFreeShipping} more needed!\n✅ Discount code live in Shopify`
  });

  return {
    gamification: {
      checkout_id: checkoutId,
      gamification_type: strategy.element,
      discount_code: discountCode,
      discount_value: strategy.discount,
      probability: strategy.probability,
      message: strategy.message,
      ui_config: {
        show_progress_bar: true,
        progress_percent: progressPercent,
        remaining_for_free_shipping: remainingForFreeShipping,
        show_spin_wheel: strategy.element === 'spin_wheel',
        show_mystery_box: strategy.element === 'mystery_box',
        wheel_segments: [
          { label: '10% OFF', value: '10%' },
          { label: '5% OFF', value: '5%' },
          { label: 'Free Shipping', value: 'free_shipping' },
          { label: 'Try Again', value: null }
        ]
      },
      engagement_score: engagementScore
    }
  };
}

module.exports = { handleGamifiedCheckout };
