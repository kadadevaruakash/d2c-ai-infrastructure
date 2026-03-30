const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { sendInventoryEmail } = require('../../shared/email');
const { notify } = require('../../shared/notification');

async function handleInventoryUpdate(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { inventory_item_id, location_id, available } = payload;

  // Only act on restock (available > 0) events
  if (typeof available !== 'number' || available <= 0) {
    return { skipped: true, reason: 'not a restock event' };
  }

  // Look up product from inventory item
  const { data: productData } = await sb
    .from('products')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('inventory_item_id', String(inventory_item_id))
    .limit(1);

  const product = productData?.[0];
  if (!product) return { skipped: true, reason: 'product not found' };

  // Get waitlist customers
  const { data: waitlist } = await sb
    .from('waitlist')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('product_id', product.id)
    .eq('notified', false)
    .limit(200);

  // Get VIP customers
  const { data: vips } = await sb
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('tier', 'vip')
    .limit(50);

  // AI write 3 message variants
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are an email copywriter for D2C brands. Write 3 variants of a restock/launch notification. Create urgency without being pushy. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Product: ${product.title}\nPrice: ${product.price}\nAvailable: ${available} units\nBrand: ${tenantConfig.brand_name || 'our brand'}\n\nReturn JSON:\n{"variants": [{"subject": "string", "preview": "string", "body": "string"}, ...3 variants]}`
    }
  ], 'gpt-4o-mini');

  const messaging = parseAiJson(aiRaw, {
    variants: [{
      subject: `${product.title} is back in stock!`,
      preview: 'Limited quantities available',
      body: `Great news! ${product.title} is back in stock. Grab yours before it sells out again!`
    }]
  });

  const variant = messaging.variants?.[0] || messaging.variants;

  // Notify waitlist
  let waitlistSent = 0;
  if (waitlist && waitlist.length > 0) {
    for (const entry of waitlist) {
      try {
        await sendInventoryEmail(tenantConfig, {
          to: entry.email,
          subject: variant.subject,
          body: variant.body,
          product_title: product.title,
          product_url: product.url,
          is_waitlist: true
        });
        waitlistSent++;
      } catch (err) {
        console.error(`Waitlist email failed for ${entry.email}:`, err.message);
      }
    }

    const waitlistIds = waitlist.map(w => w.id);
    await sb.from('waitlist')
      .update({ notified: true, notified_at: new Date().toISOString() })
      .in('id', waitlistIds)
      .eq('tenant_id', tenantId);
  }

  // Notify VIPs (different variant if available)
  const vipVariant = messaging.variants?.[1] || variant;
  let vipSent = 0;
  if (vips && vips.length > 0) {
    for (const vip of vips) {
      if (!vip.email) continue;
      try {
        await sendInventoryEmail(tenantConfig, {
          to: vip.email,
          subject: `[VIP Early Access] ${vipVariant.subject}`,
          body: vipVariant.body,
          product_title: product.title,
          product_url: product.url,
          is_vip: true
        });
        vipSent++;
      } catch (err) {
        console.error(`VIP email failed for ${vip.email}:`, err.message);
      }
    }
  }

  // Log event
  await sb.from('inventory_events').insert({
    tenant_id: tenantId,
    product_id: product.id,
    product_title: product.title,
    inventory_item_id: String(inventory_item_id),
    available_units: available,
    waitlist_notified: waitlistSent,
    vips_notified: vipSent,
    timestamp: new Date().toISOString()
  });

  await notify(tenantConfig, 'slack_marketing_channel', {
    text: `📦 INVENTORY DROP EXECUTED\n\nProduct: ${product.title}\nUnits Available: ${available}\nWaitlist Notified: ${waitlistSent}\nVIPs Notified: ${vipSent}`
  });

  return { waitlist_sent: waitlistSent, vip_sent: vipSent };
}

module.exports = { handleInventoryUpdate };
