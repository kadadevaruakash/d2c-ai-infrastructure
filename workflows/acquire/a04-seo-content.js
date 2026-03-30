const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');

async function runSeoContentGeneration(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Get one pending keyword
  const { data: keywords, error } = await sb
    .from('seo_keywords')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .order('priority', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Fetch keywords failed: ${error.message}`);
  if (!keywords || keywords.length === 0) return { skipped: true, reason: 'no pending keywords' };

  const keyword = keywords[0];

  // AI write full blog post (GPT-4o for quality)
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are an SEO content writer. Write a 1500-word blog post optimized for the given keyword. Include TITLE, META description, CONTENT, and CTA. Format with exact markers: TITLE:, META:, CONTENT:, CTA:'
    },
    {
      role: 'user',
      content: `Keyword: "${keyword.keyword}"\nSearch Intent: ${keyword.search_intent || 'informational'}\nBrand: ${tenantConfig.brand_name || 'our brand'}\nTone: ${tenantConfig.brand_tone || 'professional and friendly'}\n\nWrite the full blog post.`
    }
  ], 'gpt-4o');

  const content = typeof aiRaw === 'string' ? aiRaw : aiRaw?.content || '';

  const titleMatch = content.match(/TITLE:\s*(.+?)(?:\n|META:)/s);
  const metaMatch = content.match(/META:\s*(.+?)(?:\n|CONTENT:)/s);
  const contentMatch = content.match(/CONTENT:\s*([\s\S]+?)(?:CTA:|$)/);
  const ctaMatch = content.match(/CTA:\s*([\s\S]+?)$/);

  const title = titleMatch?.[1]?.trim() || `${keyword.keyword} - Complete Guide`;
  const meta = metaMatch?.[1]?.trim() || `Learn everything about ${keyword.keyword}`;
  const body = contentMatch?.[1]?.trim() || content;
  const cta = ctaMatch?.[1]?.trim() || 'Shop Now';

  const postId = 'POST-' + Date.now();
  await sb.from('blog_posts').insert({
    post_id: postId,
    tenant_id: tenantId,
    keyword_id: keyword.id,
    keyword: keyword.keyword,
    title,
    meta_description: meta,
    content: body,
    cta,
    status: 'draft',
    word_count: body.split(/\s+/).length,
    created_at: new Date().toISOString()
  });

  // Mark keyword as processed
  await sb.from('seo_keywords')
    .update({ status: 'published', last_used_at: new Date().toISOString() })
    .eq('id', keyword.id)
    .eq('tenant_id', tenantId);

  await notify(tenantConfig, 'slack_marketing_channel', {
    text: `✍️ SEO CONTENT GENERATED\n\nKeyword: "${keyword.keyword}"\nTitle: "${title}"\nWord Count: ${body.split(/\s+/).length}\nStatus: Draft (review before publishing)\nPost ID: ${postId}`
  });

  return { post_id: postId, keyword: keyword.keyword, title };
}

module.exports = { runSeoContentGeneration };
