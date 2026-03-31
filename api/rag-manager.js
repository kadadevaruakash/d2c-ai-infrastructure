'use strict';

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
async function tid(slug) { const { data } = await sb().from('tenants').select('id').eq('slug', slug).single(); return data?.id || null; }

router.get('/tenants/:slug/rag-docs', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  const { data } = await sb().from('rag_documents').select('*').eq('tenant_id', id).order('uploaded_at', { ascending: false });
  res.json(data || []);
});

router.post('/tenants/:slug/rag-docs', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  const { name, size_bytes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await sb().from('rag_documents').insert({ tenant_id: id, name, size_bytes: size_bytes || 0, status: 'processing' }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Async: mark indexed after 5s (in production this would call Pinecone chunking pipeline)
  setTimeout(async () => {
    const chunks = Math.max(10, Math.floor((size_bytes || 500000) / 3500));
    await sb().from('rag_documents').update({ status: 'indexed', chunk_count: chunks }).eq('id', data.id).catch(() => {});
  }, 5000);

  res.status(201).json(data);
});

router.delete('/tenants/:slug/rag-docs/:docId', async (req, res) => {
  const id = await tid(req.params.slug);
  if (!id) return res.status(404).json({ error: 'Tenant not found' });
  const { data: doc } = await sb().from('rag_documents').select('pinecone_ids').eq('id', req.params.docId).eq('tenant_id', id).single();
  if (doc?.pinecone_ids?.length && process.env.PINECONE_API_KEY) {
    console.log(`[RAG] Would delete ${doc.pinecone_ids.length} vectors from Pinecone for doc ${req.params.docId}`);
  }
  await sb().from('rag_documents').delete().eq('id', req.params.docId).eq('tenant_id', id);
  res.json({ deleted: true });
});

module.exports = { ragManagerRouter: router };
