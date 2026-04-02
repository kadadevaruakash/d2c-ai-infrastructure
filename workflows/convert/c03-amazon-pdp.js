'use strict';

/**
 * C-03 — Amazon PDP Optimiser
 *
 * Triggered: weekly Monday 8 AM (scheduler) or manually via webhook.
 * For each active product, fetches Shopify data + existing Amazon listing,
 * runs GPT-4o to generate an optimised title/bullets/description,
 * saves draft to `amazon_listings` table, and notifies ops via WhatsApp.
 *
 * Scheduler export : runAmazonPdpOptimization(tenantId, config)
 * Webhook export   : handleAmazonPdp(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Core handler — optimise a single product listing
// ─────────────────────────────────────────────────────────────

async function handleAmazonPdp(tenantId, payload, config) {
  const { product_id, title, body_html, vendor, product_type, tags, trigger_reason } = payload;

  if (!product_id) return { ok: false, error: 'product_id required' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY not set' };

  const model = config.ai_model_premium || 'gpt-4o';

  // ── Generate optimised Amazon copy ──────────────────────────
  const prompt = `You are an Amazon listing optimisation expert. Generate a high-converting Amazon Product Detail Page (PDP) for the following product.

Product: ${title}
Brand: ${vendor || config.brand_name}
Category: ${product_type || 'General'}
Tags: ${tags || ''}
Description: ${(body_html || '').replace(/<[^>]+>/g, '').slice(0, 800)}
${trigger_reason ? `Trigger reason: ${trigger_reason}` : ''}

Return ONLY valid JSON with these exact fields:
{
  "amazon_title": "keyword-rich title under 200 chars",
  "bullet_1": "feature/benefit bullet (start with capital, under 150 chars)",
  "bullet_2": "feature/benefit bullet",
  "bullet_3": "feature/benefit bullet",
  "bullet_4": "feature/benefit bullet",
  "bullet_5": "feature/benefit bullet",
  "description": "keyword-rich product description 150-300 words",
  "search_terms": "space-separated backend keywords (under 250 chars)",
  "suggested_category": "best Amazon browse node category"
}`;

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  const copy = JSON.parse(aiRes.data.choices[0].message.content);

  // ── Save to amazon_listings ──────────────────────────────────
  const { data: listing } = await sb()
    .from('amazon_listings')
    .upsert({
      tenant_id:          tenantId,
      shopify_product_id: product_id,
      shopify_title:      title,
      amazon_title:       copy.amazon_title,
      bullet_1:           copy.bullet_1,
      bullet_2:           copy.bullet_2,
      bullet_3:           copy.bullet_3,
      bullet_4:           copy.bullet_4,
      bullet_5:           copy.bullet_5,
      description:        copy.description,
      search_terms:       copy.search_terms,
      suggested_category: copy.suggested_category,
      status:             'pending_review',
      generated_at:       new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'tenant_id,shopify_product_id' })
    .select('id')
    .single()
    .catch(() => ({ data: null }));

  // ── Notify ops ───────────────────────────────────────────────
  await notify(config, 'amazon_listings', `Amazon listing optimised for *${title}*. Review pending.\nTitle: ${copy.amazon_title.slice(0, 80)}…`, 'info').catch(() => {});

  return {
    ok:                 true,
    workflow:           'C-03',
    product_id,
    listing_id:         listing?.id || null,
    amazon_title:       copy.amazon_title,
    status:             'pending_review',
  };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner — processes up to 10 products per tenant
// ─────────────────────────────────────────────────────────────

async function runAmazonPdpOptimization(tenantId, config) {
  if (config.feature_amazon === false) return;
  if (!process.env.OPENAI_API_KEY) return;

  // Fetch products from Shopify
  const shopifyDomain = config.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken  = config.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shopifyDomain || !shopifyToken) return;

  let products = [];
  try {
    const res = await axios.get(
      `https://${shopifyDomain}/admin/api/2024-01/products.json?limit=10&fields=id,title,body_html,vendor,product_type,tags`,
      { headers: { 'X-Shopify-Access-Token': shopifyToken } }
    );
    products = res.data.products || [];
  } catch (err) {
    console.error('[C-03] Shopify fetch failed:', err.message);
    return;
  }

  for (const product of products) {
    try {
      await handleAmazonPdp(tenantId, {
        product_id:     product.id,
        title:          product.title,
        body_html:      product.body_html,
        vendor:         product.vendor,
        product_type:   product.product_type,
        tags:           product.tags,
        trigger_reason: 'scheduled_weekly',
      }, config);
    } catch (err) {
      console.error(`[C-03] Failed for product ${product.id}:`, err.message);
    }
  }
}

module.exports = { handleAmazonPdp, runAmazonPdpOptimization };
