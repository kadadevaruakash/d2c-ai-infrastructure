'use strict';

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

async function getTenantId(slug) {
  const { data } = await sb().from('tenants').select('id').eq('slug', slug).single();
  return data?.id || null;
}

router.get('/tenants/:slug/ab-tests', async (req, res) => {
  const tid = await getTenantId(req.params.slug);
  if (!tid) return res.status(404).json({ error: 'Tenant not found' });
  const { data } = await sb().from('ab_tests').select('*').eq('tenant_id', tid).order('created_at', { ascending: false });
  res.json(data || []);
});

router.post('/tenants/:slug/ab-tests', async (req, res) => {
  const tid = await getTenantId(req.params.slug);
  if (!tid) return res.status(404).json({ error: 'Tenant not found' });
  const { workflow_id, name, variant_a, variant_b } = req.body;
  if (!workflow_id || !name || !variant_a || !variant_b) return res.status(400).json({ error: 'workflow_id, name, variant_a, variant_b required' });
  const { data, error } = await sb().from('ab_tests').insert({ tenant_id: tid, workflow_id, name, variant_a, variant_b }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/tenants/:slug/ab-tests/:id', async (req, res) => {
  const tid = await getTenantId(req.params.slug);
  if (!tid) return res.status(404).json({ error: 'Tenant not found' });
  const allowed = ['status', 'winner', 'a_sent', 'a_opened', 'b_sent', 'b_opened'];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (updates.winner) updates.status = 'completed';
  const { data, error } = await sb().from('ab_tests').update(updates).eq('id', req.params.id).eq('tenant_id', tid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/tenants/:slug/ab-tests/:id', async (req, res) => {
  const tid = await getTenantId(req.params.slug);
  if (!tid) return res.status(404).json({ error: 'Tenant not found' });
  await sb().from('ab_tests').delete().eq('id', req.params.id).eq('tenant_id', tid);
  res.json({ deleted: true });
});

module.exports = { abTestingRouter: router };
