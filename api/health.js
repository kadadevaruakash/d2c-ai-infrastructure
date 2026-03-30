/**
 * D2C AI Infrastructure — Health Check API
 *
 * GET /api/health           - Overall system status
 * GET /api/health/:tenantSlug - Tenant-specific workflow status
 *
 * Used by:
 *   - Monitoring dashboards
 *   - CEO assistant (S-04) for system status queries
 *   - On-call runbooks
 */

'use strict';

const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ──────────────────────────────────────────────
// Individual service checks
// ──────────────────────────────────────────────

async function checkSupabase() {
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await sb.from('tenants').select('id').limit(1);
    return { service: 'supabase', status: error ? 'degraded' : 'ok', latency: null };
  } catch (e) {
    return { service: 'supabase', status: 'down', error: e.message };
  }
}

async function checkOpenAI() {
  const start = Date.now();
  try {
    await axios.get('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 5000,
    });
    return { service: 'openai', status: 'ok', latency: Date.now() - start };
  } catch (e) {
    return { service: 'openai', status: 'down', error: e.message };
  }
}

async function checkShopify() {
  try {
    await axios.get(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/shop.json`,
      {
        headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
        timeout: 5000,
      }
    );
    return { service: 'shopify', status: 'ok' };
  } catch (e) {
    return { service: 'shopify', status: e.response?.status === 401 ? 'auth_error' : 'down', error: e.message };
  }
}

// ──────────────────────────────────────────────
// Main health check
// ──────────────────────────────────────────────

async function getSystemHealth() {
  const [supabase, openai, shopify] = await Promise.allSettled([
    checkSupabase(),
    checkOpenAI(),
    checkShopify(),
  ]);

  const services = [supabase, openai, shopify].map(r =>
    r.status === 'fulfilled' ? r.value : { service: 'unknown', status: 'error' }
  );

  const allOk   = services.every(s => s.status === 'ok');
  const anyDown = services.some(s => s.status === 'down');

  return {
    status:    allOk ? 'healthy' : anyDown ? 'degraded' : 'warning',
    timestamp: new Date().toISOString(),
    services,
    version:   '1.0.0',
  };
}

/**
 * Get workflow execution summary for a tenant (from Supabase metrics tables)
 */
async function getTenantHealth(tenantSlug) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: tenant } = await sb
    .from('tenants')
    .select('id, name, status')
    .eq('slug', tenantSlug)
    .single();

  if (!tenant) return { error: 'Tenant not found' };

  const tenantId = tenant.id;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // Parallel fetch of key metrics
  const [leads, recoveries, support, reviews, revenue] = await Promise.all([
    sb.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    sb.from('cart_recoveries').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('status', 'scheduled'),
    sb.from('support_interactions').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).gte('created_at', yesterday.toISOString()),
    sb.from('review_alerts').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('urgency', 'critical').eq('response_posted', false),
    sb.from('daily_reports').select('revenue, roas, has_anomalies')
      .eq('tenant_id', tenantId).order('report_date', { ascending: false }).limit(1).single(),
  ]);

  return {
    tenant: { name: tenant.name, status: tenant.status },
    snapshot: {
      total_leads:               leads.count || 0,
      pending_cart_recoveries:   recoveries.count || 0,
      support_interactions_24h:  support.count || 0,
      critical_reviews_unactioned: reviews.count || 0,
      last_revenue:              revenue.data?.revenue || 0,
      last_roas:                 revenue.data?.roas || 0,
      revenue_has_anomaly:       revenue.data?.has_anomalies || false,
    },
    timestamp: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────
// Express route handlers
// ──────────────────────────────────────────────

async function handleHealth(req, res) {
  const health = await getSystemHealth();
  const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 503 : 200;
  res.status(statusCode).json(health);
}

async function handleTenantHealth(req, res) {
  const { tenantSlug } = req.params;
  const result = await getTenantHealth(tenantSlug);
  if (result.error) return res.status(404).json(result);
  res.json(result);
}

module.exports = { getSystemHealth, getTenantHealth, handleHealth, handleTenantHealth };
