const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');

async function runAmazonPdpOptimization(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Get up to 10 active Amazon listings
  const { data: listings, error } = await sb
    .from('amazon_listings')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .limit(10);

  if (error) throw new Error(`Fetch listings failed: ${error.message}`);
  if (!listings || listings.length === 0) return { optimized: 0 };

  let optimized = 0;
  const results = [];

  for (const listing of listings) {
    try {
      const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
        {
          role: 'system',
          content: 'You are an Amazon SEO specialist. Optimize product listings for discoverability and conversion. Use A10 algorithm best practices. Return ONLY JSON.'
        },
        {
          role: 'user',
          content: `ASIN: ${listing.asin}\nCurrent Title: "${listing.title}"\nCurrent Bullets: ${JSON.stringify(listing.bullets || [])}\nCurrent Description: "${listing.description || ''}"\nCategory: ${listing.category || 'unknown'}\nPrice: ${listing.price}\nReviews: ${listing.review_count || 0} (avg ${listing.review_rating || 0})\n\nReturn JSON:\n{"optimized_title": "string (max 200 chars)", "bullets": ["string x5"], "backend_keywords": ["string"], "confidence": number (0-1), "changes_summary": "string"}`
        }
      ], 'gpt-4o-mini');

      const optimization = parseAiJson(aiRaw, {
        optimized_title: listing.title,
        bullets: listing.bullets || [],
        backend_keywords: [],
        confidence: 0.5,
        changes_summary: 'No changes'
      });

      // Store as pending_approval if confidence < 0.7, else auto-apply
      const status = optimization.confidence >= 0.7 ? 'approved' : 'pending_approval';

      await sb.from('amazon_optimizations').insert({
        tenant_id: tenantId,
        listing_id: listing.id,
        asin: listing.asin,
        original_title: listing.title,
        optimized_title: optimization.optimized_title,
        bullets: JSON.stringify(optimization.bullets),
        backend_keywords: JSON.stringify(optimization.backend_keywords),
        confidence: optimization.confidence,
        changes_summary: optimization.changes_summary,
        status,
        created_at: new Date().toISOString()
      });

      results.push({ asin: listing.asin, confidence: optimization.confidence, status });
      optimized++;
    } catch (err) {
      console.error(`Amazon PDP optimization failed for ${listing.asin}:`, err.message);
    }
  }

  const autoApproved = results.filter(r => r.status === 'approved').length;
  const pendingReview = results.filter(r => r.status === 'pending_approval').length;

  await notify(tenantConfig, 'slack_marketing_channel', {
    text: `🛒 AMAZON PDP OPTIMIZATION\n\nListings Processed: ${optimized}\nAuto-Approved: ${autoApproved}\nPending Review: ${pendingReview}\n\nCheck dashboard to approve pending optimizations.`
  });

  return { optimized, auto_approved: autoApproved, pending_review: pendingReview };
}

module.exports = { runAmazonPdpOptimization };
