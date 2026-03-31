'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query['x-api-key'];
  if (key !== process.env.API_SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function resolveToken(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const { data } = await sb()
    .from('client_portal_tokens')
    .select('tenant_id, tenants(id, slug, name, plan)')
    .eq('token_hash', hash)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data;
}

// POST /api/tenants/:slug/client-access — generate a read-only client portal token
router.post('/tenants/:slug/client-access', requireApiKey, async (req, res) => {
  const { data: tenant } = await sb().from('tenants').select('id').eq('slug', req.params.slug).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const token      = crypto.randomBytes(32).toString('hex');
  const tokenHash  = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await sb().from('client_portal_tokens').insert({
    tenant_id:  tenant.id,
    token_hash: tokenHash,
    label:      req.body.label || 'Dashboard access',
    expires_at: expiresAt.toISOString(),
  });

  res.json({ client_token: token, expires_at: expiresAt.toISOString() });
});

// GET /api/client/:token/overview
router.get('/client/:token/overview', async (req, res) => {
  const record = await resolveToken(req.params.token);
  if (!record) return res.status(401).json({ error: 'Invalid or expired token' });

  const tid = record.tenant_id;
  const [cfgRes, wfRes, leadsRes, cartsRes, ticketsRes, loyaltyRes] = await Promise.all([
    sb().from('tenant_config').select('brand_name, store_url, logo_url').eq('tenant_id', tid).single(),
    sb().from('workflow_states').select('is_active').eq('tenant_id', tid),
    sb().from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tid),
    sb().from('cart_recoveries').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'recovered'),
    sb().from('support_tickets').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'open'),
    sb().from('loyalty_transactions').select('points').eq('tenant_id', tid),
  ]);

  const totalPoints = (loyaltyRes.data || []).reduce((s, r) => s + (r.points || 0), 0);

  res.json({
    brand_name:            cfgRes.data?.brand_name || record.tenants.name,
    store_url:             cfgRes.data?.store_url,
    logo_url:              cfgRes.data?.logo_url,
    plan:                  record.tenants.plan,
    active_workflows:      (wfRes.data || []).filter(w => w.is_active).length,
    total_workflows:       24,
    total_leads:           leadsRes.count || 0,
    carts_recovered:       cartsRes.count || 0,
    open_tickets:          ticketsRes.count || 0,
    loyalty_points_issued: totalPoints,
  });
});

module.exports = { clientPortalRouter: router };
