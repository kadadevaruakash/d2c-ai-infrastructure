'use strict';

/**
 * S-03 — Review Sentiment & Alerts
 *
 * Triggered: every 15 minutes (scheduler) or via webhook when a new review arrives.
 * Fetches unprocessed reviews from `product_reviews` table (or inbound webhook payload),
 * runs GPT-4o-mini sentiment analysis, auto-drafts a response, saves to `review_responses`,
 * and escalates critical reviews to the CEO via cascade → S-04.
 *
 * Cascades → S-04 when urgency = 'critical' (score < -0.6 or rating <= 2)
 * Cascades → SC-04 when product_id present (refresh SEO meta after review mention)
 *
 * Scheduler export : runReviewAlerts(tenantId, config)
 * Webhook export   : handleReviewAlert(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Core handler — analyse a single review
// ─────────────────────────────────────────────────────────────

async function handleReviewAlert(tenantId, payload, config) {
  const { review_id, review_text, rating, reviewer_name, product_id, product_title, platform } = payload;

  if (!review_text) return { ok: false, error: 'review_text required' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY not set' };

  const model = config.ai_model_standard || 'gpt-4o-mini';

  // ── Sentiment analysis + response draft ─────────────────
  const prompt = `You are a customer experience specialist for ${config.brand_name}.

Analyse this customer review and draft a professional response.

Platform: ${platform || 'unknown'}
Product: ${product_title || 'unknown'}
Rating: ${rating || 'not provided'}/5
Reviewer: ${reviewer_name || 'Customer'}
Review: "${review_text}"

Return ONLY valid JSON:
{
  "sentiment_score": -1.0 to 1.0 (negative = bad, positive = good),
  "sentiment_label": "very_negative|negative|neutral|positive|very_positive",
  "key_issues": ["issue 1", "issue 2"],
  "key_positives": ["positive 1"],
  "urgency": "low|medium|high|critical",
  "response_draft": "professional brand response (2-4 sentences, empathetic, on-brand)",
  "internal_note": "internal action note for the team",
  "product_insight": "any product improvement insight from this review"
}`;

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  const analysis = JSON.parse(aiRes.data.choices[0].message.content);

  // ── Save response draft ──────────────────────────────────
  const { data: responseRecord } = await sb()
    .from('review_responses')
    .insert({
      tenant_id:       tenantId,
      review_id:       review_id || null,
      platform:        platform || 'unknown',
      product_id:      product_id || null,
      product_title:   product_title || null,
      reviewer_name:   reviewer_name || null,
      review_text,
      rating:          rating || null,
      sentiment_score: analysis.sentiment_score,
      sentiment_label: analysis.sentiment_label,
      key_issues:      analysis.key_issues,
      key_positives:   analysis.key_positives,
      urgency:         analysis.urgency,
      response_draft:  analysis.response_draft,
      internal_note:   analysis.internal_note,
      product_insight: analysis.product_insight,
      status:          'draft',
      created_at:      new Date().toISOString(),
    })
    .select('id')
    .single()
    .catch(() => ({ data: null }));

  // ── Mark source review as processed ─────────────────────
  if (review_id) {
    await sb().from('product_reviews')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', review_id)
      .catch(() => {});
  }

  // ── Notify team for negative / critical reviews ──────────
  const isNegative = analysis.sentiment_score < 0 || (rating && parseInt(rating) <= 3);
  const isCritical = analysis.urgency === 'critical' || analysis.sentiment_score < -0.6 || (rating && parseInt(rating) <= 2);

  if (isNegative) {
    const msg = `${isCritical ? '🚨' : '⚠️'} *${isCritical ? 'Critical' : 'Negative'} Review* — ${platform || 'store'}\n` +
      `Product: ${product_title || 'N/A'} | Rating: ${rating || '?'}/5\n` +
      `"${review_text.slice(0, 120)}${review_text.length > 120 ? '…' : ''}"\n` +
      `Sentiment: ${analysis.sentiment_label} (${analysis.sentiment_score.toFixed(2)})\n` +
      `Issues: ${(analysis.key_issues || []).join(', ') || 'none identified'}`;

    await notify(config, 'review_alerts', msg, isCritical ? 'critical' : 'warning').catch(() => {});
  }

  return {
    ok:              true,
    workflow:        'S-03',
    review_id,
    response_id:     responseRecord?.id || null,
    sentiment_score: analysis.sentiment_score,
    sentiment_label: analysis.sentiment_label,
    urgency:         analysis.urgency,
    is_critical:     isCritical,
    product_id:      product_id || null,
    // These fields are read by CASCADE_MAP to trigger S-04 and SC-04
    review_text,
    product_title,
    rating,
  };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner — process unanalysed reviews in bulk
// ─────────────────────────────────────────────────────────────

async function runReviewAlerts(tenantId, config) {
  if (!process.env.OPENAI_API_KEY) return;

  const { data: reviews } = await sb()
    .from('product_reviews')
    .select('id, review_text, rating, reviewer_name, product_id, product_title, platform')
    .eq('tenant_id', tenantId)
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(20)
    .catch(() => ({ data: [] }));

  if (!reviews || reviews.length === 0) return;

  for (const review of reviews) {
    try {
      await handleReviewAlert(tenantId, {
        review_id:     review.id,
        review_text:   review.review_text,
        rating:        review.rating,
        reviewer_name: review.reviewer_name,
        product_id:    review.product_id,
        product_title: review.product_title,
        platform:      review.platform,
      }, config);
    } catch (err) {
      console.error(`[S-03] Failed for review ${review.id}:`, err.message);
    }
  }
}

module.exports = { handleReviewAlert, runReviewAlerts };
