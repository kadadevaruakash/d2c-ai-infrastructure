const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function runSocialAutoPost(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Get one scheduled post that's due
  const { data: posts, error } = await sb
    .from('social_posts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1);

  if (error) throw new Error(`Fetch scheduled posts failed: ${error.message}`);
  if (!posts || posts.length === 0) return { skipped: true, reason: 'no posts due' };

  const post = posts[0];

  // AI write caption and hashtags
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are an Instagram content specialist. Write engaging captions with relevant hashtags. Match brand tone. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Brand: ${tenantConfig.brand_name || 'our brand'}\nTone: ${tenantConfig.brand_tone || 'friendly and engaging'}\nPost Topic: ${post.topic || post.content_brief || 'brand lifestyle'}\nProduct Focus: ${post.product_focus || 'general'}\nPlatform: Instagram\n\nReturn JSON:\n{"caption": "string (max 2200 chars)", "hashtags": ["string x10-20"], "emoji_theme": "string", "best_time": "string"}`
    }
  ], 'gpt-4o-mini');

  const content = parseAiJson(aiRaw, {
    caption: post.draft_caption || `Check out our latest! 🌟`,
    hashtags: ['#brand', '#lifestyle', '#d2c'],
    emoji_theme: '🌟',
    best_time: 'posted'
  });

  const fullCaption = `${content.caption}\n\n${content.hashtags.join(' ')}`;

  // Post to Instagram via Graph API
  const igToken = tenantConfig.instagram_access_token || process.env.INSTAGRAM_ACCESS_TOKEN;
  const igAccountId = tenantConfig.instagram_account_id || process.env.INSTAGRAM_ACCOUNT_ID;

  let instagramPostId = null;
  let postError = null;

  try {
    // Step 1: Create media container
    const containerRes = await axios.post(
      `https://graph.instagram.com/v19.0/${igAccountId}/media`,
      null,
      {
        params: {
          image_url: post.media_url,
          caption: fullCaption,
          access_token: igToken
        }
      }
    );
    const containerId = containerRes.data.id;

    // Step 2: Publish media
    const publishRes = await axios.post(
      `https://graph.instagram.com/v19.0/${igAccountId}/media_publish`,
      null,
      {
        params: {
          creation_id: containerId,
          access_token: igToken
        }
      }
    );
    instagramPostId = publishRes.data.id;
  } catch (err) {
    postError = err.message;
    console.error('Instagram post failed:', err.message);
  }

  // Update post status
  await sb.from('social_posts')
    .update({
      status: postError ? 'failed' : 'published',
      published_at: postError ? null : new Date().toISOString(),
      instagram_post_id: instagramPostId,
      final_caption: fullCaption,
      hashtags: JSON.stringify(content.hashtags),
      error: postError || null
    })
    .eq('id', post.id)
    .eq('tenant_id', tenantId);

  await notify(tenantConfig, 'slack_marketing_channel', {
    text: postError
      ? `❌ INSTAGRAM POST FAILED\n\nPost: ${post.id}\nError: ${postError}`
      : `📸 INSTAGRAM POST PUBLISHED\n\nPost ID: ${instagramPostId}\nCaption preview: ${content.caption.substring(0, 100)}...\nHashtags: ${content.hashtags.length} tags`
  });

  return { post_id: post.id, instagram_post_id: instagramPostId, status: postError ? 'failed' : 'published' };
}

module.exports = { runSocialAutoPost };
