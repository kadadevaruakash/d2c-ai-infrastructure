const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function runUgcCollector(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const igToken = tenantConfig.instagram_access_token || process.env.INSTAGRAM_ACCESS_TOKEN;

  // Fetch tagged posts and existing UGC in parallel
  const [igResult, existingResult] = await Promise.allSettled([
    axios.get('https://graph.instagram.com/me/tags', {
      params: {
        // owner field contains the IGSID — required for permission DMs
        fields: 'id,caption,media_type,media_url,permalink,timestamp,username,owner',
        access_token: igToken
      }
    }),
    sb.from('ugc_library')
      .select('post_id')
      .eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  ]);

  const igPosts = igResult.status === 'fulfilled' ? igResult.value.data?.data || [] : [];
  const existing = existingResult.status === 'fulfilled' ? existingResult.value.data || [] : [];
  const existingIds = existing.map(e => e.post_id);

  const newPosts = igPosts.filter(p => !existingIds.includes(p.id));
  if (newPosts.length === 0) return { processed: 0 };

  let processed = 0;

  for (const post of newPosts) {
    try {
      // FIX BUG-05: Use owner.id (IGSID), NOT username, for IG Messaging API
      const creatorIgsid = post.owner?.id || null;

      const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
        {
          role: 'system',
          content: 'You are a UGC curator. Analyze quality: image/video quality score, brand alignment, engagement quality. Write a friendly permission request message. Return ONLY JSON.'
        },
        {
          role: 'user',
          content: `Creator: @${post.username}\nCaption: ${post.caption || ''}\nMedia type: ${post.media_type}\n\nReturn JSON:\n{"quality_score": number (1-10), "brand_aligned": boolean, "permission_message": "string", "suggested_use": "social|ads|website", "priority": "high|medium|low"}`
        }
      ], 'gpt-4o-mini');

      const analysis = parseAiJson(aiRaw, {
        quality_score: 5,
        brand_aligned: true,
        permission_message: 'Hi! We love your post. May we share it? 🙏',
        suggested_use: 'social',
        priority: 'medium'
      });

      // Skip low quality
      if (analysis.quality_score < 5) continue;

      const ugcId = 'UGC-' + Date.now() + Math.random().toString(36).substring(2, 5);

      await sb.from('ugc_library').insert({
        ugc_id: ugcId,
        tenant_id: tenantId,
        post_id: post.id,
        platform: 'instagram',
        creator_handle: post.username,
        creator_igsid: creatorIgsid,
        media_url: post.media_url,
        permalink: post.permalink,
        caption: post.caption || '',
        quality_score: analysis.quality_score,
        brand_aligned: analysis.brand_aligned,
        permission_message: analysis.permission_message,
        suggested_use: analysis.suggested_use,
        priority: analysis.priority,
        permission_status: 'pending',
        posted_at: post.timestamp,
        created_at: new Date().toISOString()
      });

      // Send permission DM only if we have an IGSID
      // (creator must have messaged the account first for IGSID to be available)
      let dmSent = false;
      if (creatorIgsid) {
        try {
          await axios.post(
            'https://graph.instagram.com/v19.0/me/messages',
            {
              recipient: { id: creatorIgsid },
              message: { text: analysis.permission_message }
            },
            { params: { access_token: igToken }, headers: { 'Content-Type': 'application/json' } }
          );

          await sb.from('ugc_library')
            .update({ permission_status: 'requested' })
            .eq('ugc_id', ugcId)
            .eq('tenant_id', tenantId);

          dmSent = true;
        } catch (err) {
          console.error(`Permission DM failed for ${post.username}:`, err.message);
        }
      }

      await notify(tenantConfig, 'slack_marketing_channel', {
        text: `📸 NEW UGC COLLECTED\n\nCreator: @${post.username}\nQuality Score: ${analysis.quality_score}/10\nBrand Aligned: ${analysis.brand_aligned ? 'Yes' : 'No'}\nSuggested Use: ${analysis.suggested_use}\nPriority: ${analysis.priority}\n\nPermission DM: ${dmSent ? 'Sent ✅' : creatorIgsid ? 'Failed ❌' : 'Skipped — no IGSID (creator must message us first)'}`
      });

      processed++;
    } catch (err) {
      console.error(`UGC processing failed for post ${post.id}:`, err.message);
    }
  }

  return { processed };
}

module.exports = { runUgcCollector };
