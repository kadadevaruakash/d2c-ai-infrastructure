'use strict';

/**
 * D2C AI Infrastructure — Client Onboarding API
 *
 * Provisions a new white-label tenant:
 *   1. Creates tenant record
 *   2. Stores brand config
 *   3. Registers Shopify webhooks (4 events) via Shopify API
 *   4. Returns webhook URLs for client to configure remaining integrations
 *
 * POST /api/onboard
 */

const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { BrandConfig }  = require('../config/brand.config');

// Webhook events we register on Shopify
const SHOPIFY_WEBHOOK_TOPICS = [
  { topic: 'checkouts/delete',      route: 'shopify/cart-abandoned' },
  { topic: 'inventory_levels/update', route: 'shopify/inventory-update' },
  { topic: 'orders/create',          route: 'shopify/order-created' },
  { topic: 'products/create',        route: 'shopify/product-created' },
  { topic: 'checkouts/create',       route: 'shopify/checkout-started' },
];

async function onboardTenant(request) {
  const { tenantSlug, tenantName, plan = 'growth', brand = {} } = request;

  if (!tenantSlug || !tenantName) {
    throw new Error('tenantSlug and tenantName are required');
  }

  const slug = tenantSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Step 1: Create tenant ──────────────────
  const { data: tenant, error: tenantError } = await sb
    .from('tenants')
    .insert({ slug, name: tenantName, plan, active: true })
    .select()
    .single();

  if (tenantError) {
    if (tenantError.code === '23505') {
      throw new Error(`Tenant slug '${slug}' already exists`);
    }
    throw new Error(`Failed to create tenant: ${tenantError.message}`);
  }

  // ── Step 2: Build and store brand config ──
  const brandConfig = new BrandConfig(slug, brand);
  const configRow = brandConfig.toSupabaseRow(tenant.id);

  const { error: configError } = await sb.from('tenant_config').insert(configRow);
  if (configError) throw new Error(`Failed to store config: ${configError.message}`);

  // ── Step 3: Register Shopify webhooks ─────
  const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const webhookUrls = {};
  const shopifyWebhooksRegistered = [];

  const shopifyDomain = brand.shopify_shop_domain;
  const shopifyToken  = brand.shopify_access_token;

  if (shopifyDomain && shopifyToken) {
    for (const { topic, route } of SHOPIFY_WEBHOOK_TOPICS) {
      const address = `${apiBase}/webhook/${slug}/${route}`;
      try {
        await axios.post(
          `https://${shopifyDomain}/admin/api/2024-01/webhooks.json`,
          {
            webhook: {
              topic,
              address,
              format: 'json'
            }
          },
          { headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' } }
        );
        shopifyWebhooksRegistered.push(topic);
        webhookUrls[route] = address;
      } catch (err) {
        console.error(`[onboard] Shopify webhook registration failed for ${topic}:`, err.response?.data || err.message);
      }
    }
  }

  // Non-Shopify webhook URLs
  const webhookRoutes = [
    'lead-capture',
    'ig-dm',
    'customer-intel',
    'loyalty-event',
    'whatsapp-support',
    'rag-query',
    'ceo-alert',
    'sales-signal',
  ];
  for (const route of webhookRoutes) {
    webhookUrls[route] = `${apiBase}/webhook/${slug}/${route}`;
  }

  // ── Step 4: Return summary ─────────────────
  return {
    success: true,
    tenant: {
      id:   tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      plan: tenant.plan,
    },
    shopify_webhooks_registered: shopifyWebhooksRegistered,
    webhook_urls: webhookUrls,
    next_steps: [
      'Point your Meta (WhatsApp/Instagram) webhook to the whatsapp-support and ig-dm URLs above',
      'Add your Instagram Access Token and Account ID in the tenant_config table',
      'Upload your product knowledge base to Pinecone for RAG support (rag-query endpoint)',
      'Add competitor URLs to the competitors table in Supabase',
      'Populate seo_keywords table for SEO content generation (runs Mon 6AM)',
      'Add prospects to the prospects table for cold email outreach (runs daily 9AM)',
      'Schedule social posts by inserting into the social_posts table',
    ],
  };
}

async function handleOnboard(req, res) {
  try {
    const result = await onboardTenant(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

module.exports = { onboardTenant, handleOnboard };
