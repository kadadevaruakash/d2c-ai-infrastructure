'use strict';

/**
 * A-04 — SEO Content Generator
 *
 * SCENARIO 4: SEO Content Approval Flow via WhatsApp
 *
 * Flow:
 *   1. Receive product data (from SC-04 cascade or direct webhook)
 *   2. Fetch competitor keywords from I-01 data if available
 *   3. OpenAI generates full SEO package:
 *      - Page title (55–60 chars)
 *      - Meta description (150–160 chars)
 *      - H1 heading
 *      - Landing page body (300–500 words, brand voice)
 *      - 5 target keywords
 *   4. Store draft in `seo_content_drafts` (status: pending_review)
 *   5. WhatsApp content manager with draft excerpt + APPROVE/EDIT/REJECT
 *   6. Store pending WA action: context_type 'seo_approval'
 *   7. Return { draft_id, wa_sent }
 *
 * Reply handling is done in whatsapp-reply-router.js _handleSeoApproval():
 *   APPROVE          → calls publishDraft() exported from this module
 *   EDIT [feedback]  → calls regenerateDraft() exported from this module
 *   REJECT           → updates draft status = 'rejected'
 *
 * Webhook: POST /webhook/:tenantSlug/seo-content  (manual trigger)
 * Cascade: SC-04 → A-04 (new product SEO meta → generate supporting content)
 *
 * Payload:
 *   {
 *     id:         string  — Shopify product ID
 *     title:      string  — Product title
 *     body_html:  string  — Existing product description (optional)
 *     product_type: string (optional)
 *     tags:       string  (optional)
 *     keyword:    string  (optional — from SC-04 cascade)
 *     context:    string  (optional — additional context from cascade)
 *   }
 *
 * ── Required Supabase table ─────────────────────────────────
 *
 *   CREATE TABLE seo_content_drafts (
 *     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     tenant_id        UUID NOT NULL REFERENCES tenants(id),
 *     shopify_product_id TEXT,
 *     product_title    TEXT,
 *     seo_title        TEXT,
 *     meta_description TEXT,
 *     h1_heading       TEXT,
 *     body_content     TEXT,
 *     keywords         TEXT[],
 *     status           TEXT NOT NULL DEFAULT 'pending_review',
 *     feedback_used    TEXT,
 *     published_at     TIMESTAMPTZ,
 *     rejected_at      TIMESTAMPTZ,
 *     created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 */

const OpenAI           = require('openai');
const axios            = require('axios');
const { createClient } = require('@supabase/supabase-js');
const whatsapp         = require('../../shared/whatsapp');
const { storePendingAction } = require('../../api/whatsapp-reply-router');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
function ai() { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

async function handleSeoContent(tenantId, payload, config) {
  const {
    id: shopifyProductId,
    title,
    body_html = '',
    product_type = '',
    tags = '',
    keyword = '',
    context = '',
  } = payload;

  if (!title) {
    return { ok: false, error: 'Product title is required', workflow: 'A-04' };
  }

  // ── 1. Gather competitor keyword context ──────────────────
  const competitorContext = await _getCompetitorContext(tenantId, title);

  // ── 2. Generate SEO package via AI ───────────────────────
  const seo = await _generateSeoPackage({
    title,
    body_html,
    product_type,
    tags,
    keyword,
    context,
    competitorContext,
    config,
  });

  // ── 3. Store draft ────────────────────────────────────────
  const { data: draft, error: draftErr } = await sb()
    .from('seo_content_drafts')
    .insert({
      tenant_id:          tenantId,
      shopify_product_id: shopifyProductId || null,
      product_title:      title,
      seo_title:          seo.seo_title,
      meta_description:   seo.meta_description,
      h1_heading:         seo.h1_heading,
      body_content:       seo.body_content,
      keywords:           seo.keywords,
      status:             'pending_review',
      created_at:         new Date().toISOString(),
    })
    .select('id')
    .single();

  if (draftErr || !draft) {
    console.error('[A-04] Failed to store draft:', draftErr?.message);
    return { ok: false, error: draftErr?.message, workflow: 'A-04' };
  }

  // ── 4. WhatsApp approval request ─────────────────────────
  let wa_sent = false;
  const contentManagerPhone = config.content_manager_phone || config.ops_phone || config.ceo_phone;

  if (contentManagerPhone) {
    const waResult = await whatsapp.sendSeoApproval(contentManagerPhone, {
      draft_id:         draft.id,
      product_title:    title,
      seo_title:        seo.seo_title,
      meta_description: seo.meta_description,
      keywords:         seo.keywords,
      body_excerpt:     seo.body_content.slice(0, 400),
    }, config);

    wa_sent = !!waResult.message_id;

    if (wa_sent) {
      await storePendingAction({
        tenantId,
        phone:       contentManagerPhone,
        contextType: 'seo_approval',
        contextData: {
          draft_id:           draft.id,
          product_id:         shopifyProductId,
          shopify_product_id: shopifyProductId,
          product_title:      title,
        },
        ttlHours: 48,
      });
    }
  }

  return {
    ok: true, workflow: 'A-04',
    draft_id: draft.id,
    product_title: title,
    seo_title: seo.seo_title,
    meta_description: seo.meta_description,
    keywords: seo.keywords,
    wa_sent,
  };
}

// ─────────────────────────────────────────────────────────────
// Publish to Shopify (called by reply router on APPROVE)
// ─────────────────────────────────────────────────────────────

/**
 * Fetches the approved draft from DB, pushes it to Shopify,
 * and marks the draft as published.
 *
 * @param {string} draftId            - UUID from seo_content_drafts
 * @param {string} shopifyProductId   - Shopify numeric product ID
 * @param {object} config             - Tenant config
 * @returns {{ ok, product_title, handle, error }}
 */
async function publishDraft(draftId, shopifyProductId, config) {
  // ── Fetch draft ───────────────────────────────────────────
  const { data: draft, error } = await sb()
    .from('seo_content_drafts')
    .select('*')
    .eq('id', draftId)
    .single();

  if (error || !draft) {
    return { ok: false, error: 'Draft not found' };
  }

  const prodId = shopifyProductId || draft.shopify_product_id;
  if (!prodId) {
    return { ok: false, error: 'No Shopify product ID available' };
  }

  // ── Push to Shopify ───────────────────────────────────────
  const shop  = config.shopify_domain  || process.env.SHOPIFY_SHOP_DOMAIN;
  const token = config.shopify_token   || process.env.SHOPIFY_ACCESS_TOKEN;

  try {
    const { data: shopifyResp } = await axios.put(
      `https://${shop}/admin/api/2024-01/products/${prodId}.json`,
      {
        product: {
          id:               prodId,
          title:            draft.seo_title,   // Update title to SEO title
          body_html:        `<h1>${draft.h1_heading}</h1>\n${draft.body_content}`,
          metafields_global_title_tag:       draft.seo_title,
          metafields_global_description_tag: draft.meta_description,
        },
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    const handle = shopifyResp.product?.handle || prodId;

    // Mark draft published
    await sb().from('seo_content_drafts')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', draftId);

    return { ok: true, product_title: draft.product_title, handle };

  } catch (err) {
    const detail = err.response?.data?.errors || err.message;
    console.error('[A-04] Shopify publish failed:', detail);
    return { ok: false, error: String(detail) };
  }
}

// ─────────────────────────────────────────────────────────────
// Regenerate with feedback (called by reply router on EDIT)
// ─────────────────────────────────────────────────────────────

/**
 * Takes the original draft and re-generates with manager feedback.
 * Stores a new draft row (keeps original for audit trail).
 *
 * @param {string} originalDraftId
 * @param {string} feedback          - Manager's notes
 * @param {object} config
 * @returns {{ draft: { draft_id, product_title, seo_title, meta_description, keywords, body_excerpt } }}
 */
async function regenerateDraft(originalDraftId, feedback, config) {
  const { data: orig } = await sb()
    .from('seo_content_drafts')
    .select('*')
    .eq('id', originalDraftId)
    .single();

  if (!orig) return { draft: null, error: 'Original draft not found' };

  // Mark original as superseded
  await sb().from('seo_content_drafts')
    .update({ status: 'superseded' })
    .eq('id', originalDraftId);

  // Re-generate with feedback injected
  const seo = await _generateSeoPackage({
    title:       orig.product_title,
    body_html:   orig.body_content,
    keyword:     (orig.keywords || []).join(', '),
    context:     '',
    feedback,
    config,
  });

  const { data: newDraft } = await sb()
    .from('seo_content_drafts')
    .insert({
      tenant_id:          orig.tenant_id,
      shopify_product_id: orig.shopify_product_id,
      product_title:      orig.product_title,
      seo_title:          seo.seo_title,
      meta_description:   seo.meta_description,
      h1_heading:         seo.h1_heading,
      body_content:       seo.body_content,
      keywords:           seo.keywords,
      feedback_used:      feedback,
      status:             'pending_review',
      created_at:         new Date().toISOString(),
    })
    .select('id')
    .single();

  return {
    draft: {
      draft_id:         newDraft.id,
      product_title:    orig.product_title,
      seo_title:        seo.seo_title,
      meta_description: seo.meta_description,
      keywords:         seo.keywords,
      body_excerpt:     seo.body_content.slice(0, 400),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// AI content generation
// ─────────────────────────────────────────────────────────────

async function _generateSeoPackage({
  title, body_html, product_type, tags, keyword, context,
  competitorContext = '', feedback = '', config,
}) {
  const brand    = config.brand_name  || 'our brand';
  const voice    = config.brand_voice || 'professional, engaging, helpful';
  const storeUrl = config.store_url   || '';
  const model    = config.ai_model_premium || config.ai_model_standard || 'gpt-4o-mini';

  const feedbackSection = feedback
    ? `\nManager feedback on previous draft (incorporate this):\n"${feedback}"\n` : '';

  const competitorSection = competitorContext
    ? `\nCompetitor context (differentiate from these):\n${competitorContext}\n` : '';

  const plainBody = (body_html || '').replace(/<[^>]*>/g, '').slice(0, 500);

  const prompt = [
    `You are an expert SEO content writer for ${brand}, a D2C e-commerce store (${storeUrl}).`,
    `Brand voice: ${voice}`,
    ``,
    `Generate a complete SEO content package for this product:`,
    `Product title: ${title}`,
    `Product type: ${product_type || 'not specified'}`,
    `Tags: ${tags || 'not specified'}`,
    `Existing description: ${plainBody || 'not provided'}`,
    `Primary keyword hint: ${keyword || 'derive from product title'}`,
    `Additional context: ${context || 'none'}`,
    feedbackSection,
    competitorSection,
    ``,
    `Deliverables:`,
    `1. seo_title: 55–60 characters, includes primary keyword, brand name optional`,
    `2. meta_description: 150–160 characters, action-oriented, includes keyword`,
    `3. h1_heading: Compelling H1 (different from seo_title), max 60 chars`,
    `4. body_content: 300–500 word landing page section in HTML-free plain text.`,
    `   Include 3 short paragraphs + 3 benefit bullet points (prefix with •).`,
    `5. keywords: Array of exactly 5 target keywords (short-tail + long-tail mix)`,
    ``,
    `Respond ONLY with valid JSON — no markdown:`,
    `{"seo_title":"...","meta_description":"...","h1_heading":"...","body_content":"...","keywords":["...","...","...","...","..."]}`,
  ].filter(Boolean).join('\n');

  try {
    const completion = await ai().chat.completions.create({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.6,
      max_tokens:  900,
    });
    const raw = completion.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('[A-04] SEO generation failed:', err.message);
    return {
      seo_title:        `${title} | ${config.brand_name || ''}`.slice(0, 60),
      meta_description: `Shop ${title} at ${config.brand_name || 'our store'}. Free shipping available.`.slice(0, 160),
      h1_heading:       `Shop ${title}`,
      body_content:     `Discover our ${title}. Built with quality in mind for customers who expect the best.`,
      keywords:         [title.toLowerCase(), 'buy online', 'free shipping', 'quality', 'best price'],
    };
  }
}

async function _getCompetitorContext(tenantId, productTitle) {
  try {
    const { data } = await sb()
      .from('competitor_data')
      .select('competitor_name, headline, price')
      .eq('tenant_id', tenantId)
      .ilike('product_name', `%${productTitle.split(' ')[0]}%`)
      .order('scraped_at', { ascending: false })
      .limit(3);

    if (!data || data.length === 0) return '';
    return data.map(c =>
      `${c.competitor_name}: "${c.headline}" — ${c.price || 'price N/A'}`
    ).join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  handleSeoContent,
  publishDraft,
  regenerateDraft,
};
