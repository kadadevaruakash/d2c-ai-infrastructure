'use strict';

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
async function tid(slug) { const { data } = await sb().from('tenants').select('id').eq('slug', slug).single(); return data?.id || null; }

router.get('/tenants/:slug/content', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  let q = sb().from('content_items').select('id,title,type,platform,status,keyword,scheduled_at,published_at,source_workflow,created_at').eq('tenant_id', id).order('created_at', { ascending: false });
  if (req.query.status) q = q.eq('status', req.query.status);
  const { data } = await q;
  res.json(data || []);
});

router.post('/tenants/:slug/content', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  const { title, type, platform, status, content, keyword, scheduled_at, source_workflow } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await sb().from('content_items').insert({ tenant_id: id, title, type: type || 'blog', platform: platform || 'Website', status: status || 'draft', content, keyword, scheduled_at, source_workflow }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/tenants/:slug/content/:itemId', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  const allowed = ['title', 'type', 'platform', 'status', 'content', 'keyword', 'scheduled_at', 'published_at'];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (updates.status === 'published' && !updates.published_at) updates.published_at = new Date().toISOString();
  const { data, error } = await sb().from('content_items').update(updates).eq('id', req.params.itemId).eq('tenant_id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/tenants/:slug/content/:itemId', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  await sb().from('content_items').delete().eq('id', req.params.itemId).eq('tenant_id', id);
  res.json({ deleted: true });
});

module.exports = { contentCalendarRouter: router };
