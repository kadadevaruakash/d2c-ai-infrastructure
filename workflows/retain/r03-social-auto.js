'use strict';

/**
 * R-03 — Social Auto-Post
 *
 * Triggered: 3× daily at 10 AM, 2 PM, 6 PM (scheduler) or manually.
 * Fetches scheduled posts from `social_posts` table (status = 'scheduled'),
 * generates AI captions if missing, posts to Instagram Graph API,
 * updates post status, and logs results.
 *
 * Also handles inbound social_post webhook for immediate publishing.
 *
 * Scheduler export : runSocialAutoPost(tenantId, config)
 * Webhook export   : handleSocialPost(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Caption generator
// ─────────────────────────────────────────────────────────────

async function _generateCaption(post, config) {
  if (!process.env.OPENAI_API_KEY) return post.caption || '';

  const prompt = `Write an engaging Instagram caption for ${config.brand_name}.

Post type: ${post.post_type || 'product'}
Topic/product: ${post.topic || post.title || ''}
Brand voice: ${config.brand_voice || 'friendly, expert, inspiring'}
Include: relevant emojis, a call-to-action, 5-8 relevant hashtags
Max length: 300 characters for caption + hashtags on new line

Return ONLY valid JSON: { "caption": "caption text", "hashtags": "#tag1 #tag2 #tag3..." }`;

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: config.ai_model_standard || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });

  const parsed = JSON.parse(aiRes.data.choices[0].message.content);
  return `${parsed.caption}\n\n${parsed.hashtags}`;
}

// ─────────────────────────────────────────────────────────────
// Instagram publisher
// ─────────────────────────────────────────────────────────────

async function _publishToInstagram(post, caption, config) {
  const pageId    = post.ig_page_id    || config.ig_page_id;
  const pageToken = post.ig_page_token || config.ig_page_token || process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!pageId || !pageToken) return { ok: false, error: 'ig_page_id or ig_page_token not configured' };
  if (!post.image_url) return { ok: false, error: 'image_url required for Instagram post' };

  try {
    // Step 1: Create media container
    const containerRes = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/media`,
      null,
      {
        params: { image_url: post.image_url, caption, access_token: pageToken },
      }
    );
    const creationId = containerRes.data.id;

    // Step 2: Publish container
    const publishRes = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/media_publish`,
      null,
      { params: { creation_id: creationId, access_token: pageToken } }
    );

    return { ok: true, ig_media_id: publishRes.data.id };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    return { ok: false, error: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────
// Core handler — post a single item
// ─────────────────────────────────────────────────────────────

async function handleSocialPost(tenantId, payload, config) {
  const post = payload;
  if (!post.platform) return { ok: false, error: 'platform required (instagram|twitter|facebook)' };

  // Generate caption if not provided
  const caption = post.caption || await _generateCaption(post, config);

  let result = { ok: false, error: 'unsupported platform' };

  if (post.platform === 'instagram') {
    result = await _publishToInstagram(post, caption, config);
  }
  // Future: Twitter/X, Facebook, TikTok publishers here

  // ── Update post record in Supabase ───────────────────────
  if (post.id) {
    await sb().from('social_posts').update({
      status:       result.ok ? 'published' : 'failed',
      ig_media_id:  result.ig_media_id || null,
      published_at: result.ok ? new Date().toISOString() : null,
      error_msg:    result.error || null,
      updated_at:   new Date().toISOString(),
    }).eq('id', post.id).catch(() => {});
  }

  if (result.ok) {
    await notify(config, 'social_posts', `✅ Posted to ${post.platform}: "${(caption || '').slice(0, 60)}…"`, 'info').catch(() => {});
  }

  return { ok: result.ok, workflow: 'R-03', platform: post.platform, ig_media_id: result.ig_media_id, error: result.error };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner — process due scheduled posts
// ─────────────────────────────────────────────────────────────

async function runSocialAutoPost(tenantId, config) {
  const now = new Date().toISOString();

  const { data: posts } = await sb()
    .from('social_posts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(10)
    .catch(() => ({ data: [] }));

  if (!posts || posts.length === 0) return;

  let published = 0;
  let failed    = 0;

  for (const post of posts) {
    const r = await handleSocialPost(tenantId, post, config);
    if (r.ok) published++; else failed++;
  }

  if (published > 0 || failed > 0) {
    console.log(`[R-03] tenant=${tenantId} published=${published} failed=${failed}`);
  }
}

module.exports = { handleSocialPost, runSocialAutoPost };
