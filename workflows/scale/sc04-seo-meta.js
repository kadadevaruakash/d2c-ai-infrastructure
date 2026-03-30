const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function handleProductCreated(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const product = payload;

  const productId = product.id;
  const title = product.title || '';
  const description = product.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
  const productType = product.product_type || '';
  const tags = product.tags || '';
  const vendor = product.vendor || tenantConfig.brand_name || '';

  // AI generate SEO meta tags
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are an e-commerce SEO specialist. Generate optimized meta tags for Shopify products. Follow Google best practices. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Product Title: "${title}"\nDescription: "${description.substring(0, 500)}"\nType: ${productType}\nVendor: ${vendor}\nTags: ${tags}\n\nReturn JSON:\n{"meta_title": "string (50-60 chars)", "meta_description": "string (150-160 chars)", "og_title": "string", "og_description": "string", "keywords": ["string x5-8"], "schema_type": "Product", "focus_keyword": "string"}`
    }
  ], 'gpt-4o-mini');

  const seo = parseAiJson(aiRaw, {
    meta_title: title.substring(0, 60),
    meta_description: description.substring(0, 160),
    og_title: title,
    og_description: description.substring(0, 200),
    keywords: [],
    schema_type: 'Product',
    focus_keyword: title
  });

  // Store in Supabase
  const metaId = 'SEO-' + Date.now();
  await sb.from('seo_meta_tags').insert({
    meta_id: metaId,
    tenant_id: tenantId,
    product_id: String(productId),
    product_title: title,
    meta_title: seo.meta_title,
    meta_description: seo.meta_description,
    og_title: seo.og_title,
    og_description: seo.og_description,
    keywords: JSON.stringify(seo.keywords),
    focus_keyword: seo.focus_keyword,
    created_at: new Date().toISOString()
  });

  // Update Shopify product metafields
  const shopifyDomain = tenantConfig.shopify_shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const shopifyToken = tenantConfig.shopify_access_token || process.env.SHOPIFY_ACCESS_TOKEN;

  let shopifyUpdated = false;
  try {
    await axios.put(
      `https://${shopifyDomain}/admin/api/2024-01/products/${productId}.json`,
      {
        product: {
          id: productId,
          metafields_global_title_tag: seo.meta_title,
          metafields_global_description_tag: seo.meta_description
        }
      },
      { headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' } }
    );
    shopifyUpdated = true;
  } catch (err) {
    console.error('Shopify metafield update failed:', err.message);
  }

  await notify(tenantConfig, 'slack_marketing_channel', {
    text: `🔍 SEO META TAGS GENERATED\n\nProduct: "${title}"\nMeta Title: "${seo.meta_title}"\nFocus Keyword: "${seo.focus_keyword}"\nKeywords: ${seo.keywords.join(', ')}\nShopify Updated: ${shopifyUpdated ? '✅' : '❌ (check logs)'}`
  });

  return {
    meta_id: metaId,
    meta_title: seo.meta_title,
    focus_keyword: seo.focus_keyword,
    shopify_updated: shopifyUpdated
  };
}

module.exports = { handleProductCreated };
