'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
function hashKey(k) { return crypto.createHash('sha256').update(k).digest('hex'); }

async function requireAgency(req, res, next) {
  const key = req.headers['x-agency-key'];
  if (!key) return res.status(401).json({ error: 'x-agency-key header required' });
  const { data } = await sb().from('agency_accounts').select('*').eq('api_key_hash', hashKey(key)).single();
  if (!data || data.status !== 'active') return res.status(401).json({ error: 'Invalid agency key' });
  req.agency = data;
  next();
}

// POST /api/agency/login
router.post('/login', async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });
  const { data } = await sb().from('agency_accounts').select('*').eq('api_key_hash', hashKey(api_key)).single();
  if (!data || data.status !== 'active') return res.status(401).json({ error: 'Invalid agency key' });
  res.json({ agency: { id: data.id, name: data.name, slug: data.slug, plan: data.plan }, token: api_key });
});

// GET /api/agency/tenants
router.get('/tenants', requireAgency, async (req, res) => {
  const { data: links } = await sb()
    .from('agency_tenants')
    .select('tenant_id, tenants(id, slug, name, plan, status, created_at)')
    .eq('agency_id', req.agency.id);

  if (!links || links.length === 0) return res.json([]);

  const enriched = await Promise.all(links.map(async (link) => {
    const t = link.tenants;
    const [wfRes, logRes] = await Promise.all([
      sb().from('workflow_states').select('is_active', { count: 'exact' }).eq('tenant_id', t.id).eq('is_active', true),
      sb().from('workflow_execution_logs').select('created_at').eq('tenant_id', t.id).order('created_at', { ascending: false }).limit(1),
    ]);
    return { ...t, active_workflows: wfRes.count || 0, last_activity: logRes.data?.[0]?.created_at || null };
  }));

  res.json(enriched);
});

// POST /api/agency/tenants — provision new tenant under this agency
router.post('/tenants', requireAgency, async (req, res) => {
  req.headers['x-api-key'] = process.env.API_SECRET_KEY;
  const { handleOnboard } = require('./onboarding');

  let result = null;
  const fakeRes = {
    status: (code) => ({ json: (d) => { result = { code, data: d }; } }),
    json: (d) => { result = { code: 200, data: d }; },
  };

  await handleOnboard(req, fakeRes);

  if (result?.data?.tenantId) {
    await sb().from('agency_tenants').insert({ agency_id: req.agency.id, tenant_id: result.data.tenantId }).catch(() => {});
  }

  res.status(result?.code || 200).json(result?.data || {});
});

module.exports = { agencyRouter: router };
