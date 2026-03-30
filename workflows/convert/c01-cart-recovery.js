const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { sendCartRecoveryEmail } = require('../../shared/email');
const { notify } = require('../../shared/notification');
const axios = require('axios');

// Called on Shopify cart_abandoned webhook
async function handleCartAbandoned(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const checkout = payload;

  const cartValue = parseFloat(checkout.total_price || 0);
  const items = (checkout.line_items || []).map(item => ({
    name: item.title,
    price: item.price,
    quantity: item.quantity
  }));

  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a cart recovery specialist for a D2C brand. Determine best channel, timing, and incentive. Return ONLY valid JSON.'
    },
    {
      role: 'user',
      content: `Cart value: $${cartValue}\nItems: ${items.length}\nCustomer ID: ${checkout.customer?.id || 'unknown'}\nHas phone: ${checkout.phone ? 'yes' : 'no'}\n\nReturn JSON:\n{"channel": "email|sms|whatsapp", "delay_minutes": number, "incentive": "none|5%|10%|free_shipping", "tone": "urgent|friendly|exclusive", "message_preview": "string"}`
    }
  ], 'gpt-4o-mini');

  const strategy = parseAiJson(aiRaw, {
    channel: 'email',
    delay_minutes: 60,
    incentive: cartValue > 100 ? '10%' : '5%',
    tone: 'friendly',
    message_preview: 'Complete your purchase'
  });

  // If AI recommends WA/SMS but no phone — fall back to email
  let channel = strategy.channel;
  if ((channel === 'whatsapp' || channel === 'sms') && !checkout.phone) {
    channel = 'email';
  }

  const recoveryId = 'REC-' + Date.now();
  const scheduledTime = new Date(Date.now() + strategy.delay_minutes * 60000).toISOString();

  await sb.from('cart_recoveries').insert({
    recovery_id: recoveryId,
    tenant_id: tenantId,
    checkout_id: checkout.id || checkout.token,
    customer_email: checkout.email,
    customer_phone: checkout.phone || null,
    cart_value: cartValue,
    items: JSON.stringify(items),
    channel,
    delay_minutes: strategy.delay_minutes,
    scheduled_time: scheduledTime,
    incentive: strategy.incentive,
    tone: strategy.tone,
    message_preview: strategy.message_preview,
    status: 'scheduled',
    created_at: new Date().toISOString()
  });

  return { recovery_id: recoveryId, channel, scheduled_time: scheduledTime };
}

// Called by cron every hour
async function processDueRecoveries(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: due, error } = await sb
    .from('cart_recoveries')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .lte('scheduled_time', new Date().toISOString());

  if (error) throw new Error(`Fetch due recoveries failed: ${error.message}`);
  if (!due || due.length === 0) return { processed: 0 };

  let processed = 0;
  for (const rec of due) {
    try {
      if (rec.channel === 'whatsapp') {
        const waToken = tenantConfig.whatsapp_token || process.env.WHATSAPP_TOKEN;
        const waPhoneId = tenantConfig.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
        const incentiveText = rec.incentive !== 'none'
          ? `Special offer just for you: ${rec.incentive} off!`
          : 'Complete your purchase before it sells out!';

        await axios.post(
          `https://graph.facebook.com/v18.0/${waPhoneId}/messages`,
          {
            messaging_product: 'whatsapp',
            to: rec.customer_phone,
            type: 'text',
            text: { body: `👋 Hey! You left $${rec.cart_value} in your cart.\n\n${incentiveText}\n\n🛒 ${process.env.API_BASE_URL}/checkout/${rec.checkout_id}` }
          },
          { headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' } }
        );
      } else {
        await sendCartRecoveryEmail(tenantConfig, {
          to: rec.customer_email,
          cart_value: rec.cart_value,
          incentive: rec.incentive,
          checkout_id: rec.checkout_id
        });
      }

      await sb.from('cart_recoveries')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('recovery_id', rec.recovery_id)
        .eq('tenant_id', tenantId);

      processed++;
    } catch (err) {
      console.error(`Cart recovery ${rec.recovery_id} failed:`, err.message);
    }
  }

  return { processed };
}

module.exports = { handleCartAbandoned, processDueRecoveries };
