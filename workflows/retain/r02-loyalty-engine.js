const { createClient } = require('@supabase/supabase-js');
const { getCustomer } = require('../../shared/customer');
const { sendTierUpgradeEmail } = require('../../shared/email');
const { notify } = require('../../shared/notification');
const axios = require('axios');

const TIERS = [
  { name: 'bronze', min: 0, max: 499, discount: 0 },
  { name: 'silver', min: 500, max: 1499, discount: 5 },
  { name: 'gold', min: 1500, max: 4999, discount: 10 },
  { name: 'platinum', min: 5000, max: Infinity, discount: 15 }
];

const POINTS_RULES = {
  purchase: (value) => Math.floor(value),
  referral: () => 50,
  review: () => 25,
  social_share: () => 10,
  birthday: () => 100
};

async function handleLoyaltyEvent(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { customer_id, event_type, value, reference_id } = payload;
  if (!customer_id) return { success: false, error: 'customer_id required' };

  const pointsEarned = POINTS_RULES[event_type]
    ? POINTS_RULES[event_type](value || 0)
    : 0;

  // Get loyalty account
  const { data: accountData } = await sb
    .from('loyalty_accounts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customer_id)
    .limit(1);

  const account = accountData?.[0];
  const currentPoints = account?.points_balance || 0;
  const lifetimePoints = (account?.lifetime_points || 0) + pointsEarned;
  const newBalance = currentPoints + pointsEarned;

  const currentTier = account?.tier || 'bronze';
  const newTier = TIERS.find(t => lifetimePoints >= t.min && lifetimePoints <= t.max)?.name || 'bronze';
  const tierUpgraded = newTier !== currentTier &&
    TIERS.findIndex(t => t.name === newTier) > TIERS.findIndex(t => t.name === currentTier);
  const tierDiscount = TIERS.find(t => t.name === newTier)?.discount || 0;

  // Upsert loyalty account
  await sb.from('loyalty_accounts').upsert({
    tenant_id: tenantId,
    customer_id,
    points_balance: newBalance,
    lifetime_points: lifetimePoints,
    tier: newTier,
    updated_at: new Date().toISOString()
  }, { onConflict: 'tenant_id,customer_id' });

  // Log transaction
  await sb.from('loyalty_transactions').insert({
    tenant_id: tenantId,
    customer_id,
    event_type: event_type || 'purchase',
    points: pointsEarned,
    balance_after: newBalance,
    reference_id: reference_id || null,
    created_at: new Date().toISOString()
  });

  // Handle tier upgrade notifications
  if (tierUpgraded) {
    const customer = await getCustomer(tenantId, { customer_id });
    if (!customer) {
      console.error(`Customer ${customer_id} not found for tier upgrade notification`);
    } else {
      const customerName = customer.first_name || 'there';

      // Send WhatsApp if phone available
      if (customer.phone) {
        try {
          const waToken = tenantConfig.whatsapp_token || process.env.WHATSAPP_TOKEN;
          const waPhoneId = tenantConfig.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
          await axios.post(
            `https://graph.facebook.com/v18.0/${waPhoneId}/messages`,
            {
              messaging_product: 'whatsapp',
              to: customer.phone,
              type: 'text',
              text: {
                body: `🎉 CONGRATULATIONS ${customerName}!\n\nYou've been upgraded to ${newTier.toUpperCase()} tier!\n\n✨ New Benefits:\n• ${tierDiscount}% discount on all orders\n• Early access to sales\n• Exclusive products\n\nYour points: ${newBalance}`
              }
            },
            { headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          console.error('WhatsApp tier upgrade failed:', err.message);
        }
      }

      // Always send email
      if (customer.email) {
        await sendTierUpgradeEmail(tenantConfig, {
          to: customer.email,
          first_name: customerName,
          new_tier: newTier,
          tier_discount: tierDiscount,
          points_balance: newBalance
        });
      }
    }
  }

  return {
    status: 'success',
    points_earned: pointsEarned,
    new_balance: newBalance,
    tier: newTier,
    tier_upgraded: tierUpgraded
  };
}

module.exports = { handleLoyaltyEvent };
