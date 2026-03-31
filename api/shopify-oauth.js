'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

const SCOPES = 'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_inventory,write_inventory,read_checkouts';

// GET /api/shopify/install?shop=example.myshopify.com&tenant_slug=brand
router.get('/install', (req, res) => {
  const { shop, tenant_slug } = req.query;
  if (!shop || !tenant_slug) return res.status(400).json({ error: 'shop and tenant_slug required' });
  if (!process.env.SHOPIFY_API_KEY) return res.status(503).json({ error: 'SHOPIFY_API_KEY not configured' });

  const state = Buffer.from(JSON.stringify({ tenant_slug, nonce: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/api/shopify/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(installUrl);
});

// GET /api/shopify/callback?code=...&shop=...&state=...&hmac=...
router.get('/callback', async (req, res) => {
  const { code, shop, state, hmac } = req.query;
  if (!code || !shop || !state) return res.status(400).json({ error: 'Missing OAuth params' });
  if (!process.env.SHOPIFY_API_SECRET) return res.status(503).json({ error: 'SHOPIFY_API_SECRET not configured' });

  // Verify HMAC
  const params = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'hmac').sort());
  const message = new URLSearchParams(params).toString();
  const digest  = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(message).digest('hex');
  if (digest !== hmac) return res.status(403).json({ error: 'HMAC verification failed' });

  let tenantSlug;
  try { tenantSlug = JSON.parse(Buffer.from(state, 'base64url').toString()).tenant_slug; }
  catch { return res.status(400).json({ error: 'Invalid state param' }); }

  // Exchange code for access token
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.SHOPIFY_API_KEY, client_secret: process.env.SHOPIFY_API_SECRET, code }),
  });
  const { access_token } = await tokenRes.json();
  if (!access_token) return res.status(500).json({ error: 'Failed to get access token from Shopify' });

  const { data: tenant } = await sb().from('tenants').select('id').eq('slug', tenantSlug).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  await sb().from('tenant_config').update({
    shopify_shop_domain:   shop,
    shopify_access_token:  access_token,
    updated_at: new Date().toISOString(),
  }).eq('tenant_id', tenant.id);

  res.redirect(`/?shopify_connected=true&shop=${encodeURIComponent(shop)}`);
});

module.exports = { shopifyOauthRouter: router };
