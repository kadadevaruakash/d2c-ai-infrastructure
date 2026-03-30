const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

// GMB returns word-form star ratings, not numeric
const STAR_MAP = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 };

async function runReviewAlerts(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const gmbAccountId = tenantConfig.gmb_account_id || process.env.GMB_ACCOUNT_ID;
  const gmbLocationId = tenantConfig.gmb_location_id || process.env.GMB_LOCATION_ID;
  const gmbToken = tenantConfig.gmb_access_token || process.env.GMB_ACCESS_TOKEN;

  // Fetch GMB reviews and recent alerts in parallel
  const [reviewsResult, recentAlertsResult] = await Promise.allSettled([
    axios.get(
      `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/reviews`,
      {
        params: { pageSize: 10 },
        headers: { Authorization: `Bearer ${gmbToken}` }
      }
    ),
    sb.from('review_alerts')
      .select('review_id')
      .eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
  ]);

  const gmbReviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value.data?.reviews || [] : [];
  const recentAlerts = recentAlertsResult.status === 'fulfilled' ? recentAlertsResult.value.data || [] : [];
  const alertedIds = recentAlerts.map(a => a.review_id);

  const newReviews = gmbReviews.filter(r => {
    const id = r.reviewId || r.name;
    return !alertedIds.includes(id);
  }).map(r => ({
    review_id: r.reviewId || r.name,
    platform: 'google',
    // FIX: STAR_MAP handles "FIVE", "FOUR", etc. — NOT parseInt(replace('STAR_', ''))
    rating: r.starRating ? (STAR_MAP[r.starRating] || 5) : 5,
    review_text: r.comment || '',
    reviewer_name: r.reviewer?.displayName || 'Anonymous',
    review_time: r.createTime || new Date().toISOString()
  }));

  if (newReviews.length === 0) return { processed: 0 };

  let processed = 0;

  for (const review of newReviews) {
    try {
      const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
        {
          role: 'system',
          content: 'You are a reputation management specialist. Analyze sentiment, draft an appropriate response. Empathetic for negative reviews. Thank positive reviewers. Never defensive. Return ONLY JSON.'
        },
        {
          role: 'user',
          content: `Platform: ${review.platform}\nRating: ${review.rating}/5\nReview: '${review.review_text}'\nReviewer: ${review.reviewer_name}\n\nReturn JSON:\n{"sentiment": "positive|neutral|negative", "urgency": "low|medium|high|critical", "response_draft": "string", "action_required": "string"}`
        }
      ], 'gpt-4o-mini');

      const analysis = parseAiJson(aiRaw, {
        sentiment: review.rating >= 4 ? 'positive' : review.rating <= 2 ? 'negative' : 'neutral',
        urgency: review.rating <= 2 ? 'high' : 'low',
        response_draft: 'Thank you for your feedback!',
        action_required: 'none'
      });

      let alertChannel = 'slack_cx_channel';
      if (analysis.urgency === 'critical') alertChannel = 'slack_urgent_channel';
      else if (analysis.urgency === 'high') alertChannel = 'slack_cx_channel';

      const alertId = 'REV-' + Date.now() + Math.random().toString(36).substring(2, 5);

      await sb.from('review_alerts').insert({
        alert_id: alertId,
        tenant_id: tenantId,
        review_id: review.review_id,
        platform: review.platform,
        rating: review.rating,
        reviewer_name: review.reviewer_name,
        review_text: review.review_text,
        sentiment: analysis.sentiment,
        urgency: analysis.urgency,
        response_draft: analysis.response_draft,
        action_required: analysis.action_required,
        created_at: new Date().toISOString()
      });

      await notify(tenantConfig, alertChannel, {
        text: `⭐ NEW REVIEW ALERT\n\nPlatform: ${review.platform}\nRating: ${review.rating}/5 ⭐\nSentiment: ${analysis.sentiment}\nUrgency: ${analysis.urgency}\n\nReviewer: ${review.reviewer_name}\n"${review.review_text.substring(0, 200)}"\n\n💬 Suggested Response:\n${analysis.response_draft}${analysis.urgency === 'critical' ? '\n\n⚠️ CRITICAL — Requires immediate attention' : ''}`
      });

      if (analysis.urgency === 'critical') {
        await notify(tenantConfig, 'email_manager', {
          subject: '🚨 CRITICAL REVIEW ALERT',
          text: `A critical review requires immediate attention.\n\nRating: ${review.rating}/5\nReview: ${review.review_text}\n\nSuggested Response:\n${analysis.response_draft}\n\nAction Required: ${analysis.action_required}`
        });
      }

      processed++;
    } catch (err) {
      console.error(`Review alert failed for ${review.review_id}:`, err.message);
    }
  }

  return { processed };
}

module.exports = { runReviewAlerts };
