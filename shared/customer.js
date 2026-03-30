/**
 * D2C AI Infrastructure — Shared Customer Context Utility
 *
 * Replaces the 8 duplicate customer lookup nodes across workflows.
 * Returns a fully enriched customer object (CRM + loyalty + intelligence).
 *
 * Workflows that use this: A-01, C-01, C-04, R-01, R-02, S-01, I-03, SC-03
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Look up a customer by identifier.
 * @param {string} tenantId
 * @param {object} lookup  - One of: { email } | { phone } | { shopify_id } | { id }
 * @returns {object|null}  - Customer row or null if not found
 */
async function getCustomer(tenantId, lookup) {
  const sb = getSupabase();

  let query = sb
    .from('customers')
    .select('*, loyalty_accounts(*), customer_intelligence(*)')
    .eq('tenant_id', tenantId)
    .limit(1);

  if (lookup.email)      query = query.eq('email', lookup.email.toLowerCase());
  else if (lookup.phone) query = query.eq('phone', lookup.phone);
  else if (lookup.shopify_id) query = query.eq('shopify_id', String(lookup.shopify_id));
  else if (lookup.id)    query = query.eq('id', lookup.id);
  else throw new Error('getCustomer: must provide email, phone, shopify_id, or id');

  const { data, error } = await query.single();

  if (error && error.code !== 'PGRST116') {
    console.error('[customer] Lookup error:', error.message);
    return null;
  }

  if (!data) return null;

  // Flatten loyalty data into the customer object
  const loyalty = data.loyalty_accounts?.[0] || {};
  const intel   = data.customer_intelligence?.[0] || {};

  return {
    ...data,
    loyalty_accounts: undefined,    // remove nested array
    customer_intelligence: undefined,
    // Loyalty enrichment
    points_balance:  loyalty.points_balance || 0,
    lifetime_points: loyalty.lifetime_points || 0,
    tier:            loyalty.tier || 'bronze',
    tier_discount:   loyalty.tier_discount || 0,
    // Intelligence enrichment
    churn_risk_score:   intel.churn_risk_score || 0,
    sentiment_trend:    intel.sentiment_trend || 'stable',
    ltv_prediction:     intel.ltv_prediction || 0,
    product_affinity:   intel.product_affinity || [],
    segment_intel:      intel.segment || data.segment || 'New',
  };
}

/**
 * Upsert a customer record after an order or interaction.
 * @param {string} tenantId
 * @param {object} data
 * @returns {object} - Updated customer row
 */
async function upsertCustomer(tenantId, data) {
  const sb = getSupabase();

  const { data: row, error } = await sb
    .from('customers')
    .upsert(
      {
        tenant_id:  tenantId,
        ...data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,email' }
    )
    .select()
    .single();

  if (error) {
    console.error('[customer] Upsert error:', error.message);
    return null;
  }
  return row;
}

/**
 * Get at-risk customers eligible for winback.
 * @param {string} tenantId
 * @param {number} inactiveDays - Days since last order
 * @param {number} limit
 */
async function getAtRiskCustomers(tenantId, inactiveDays = 60, limit = 50) {
  const sb = getSupabase();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

  const { data, error } = await sb
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('winback_sent', false)
    .lte('last_order_date', cutoffDate.toISOString().split('T')[0])
    .limit(limit);

  if (error) {
    console.error('[customer] At-risk fetch error:', error.message);
    return [];
  }
  return data || [];
}

module.exports = { getCustomer, upsertCustomer, getAtRiskCustomers };
