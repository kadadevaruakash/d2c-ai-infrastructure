'use strict';

/**
 * SC-01 — UGC Collector
 *
 * Triggered: every 6 hours (scheduler) or manually via webhook.
 * Scans Instagram mentions/tags (via Instagram Graph API) and stored UGC leads,
 * scores creators by follower count + engagement, identifies top UGC candidates,
 * generates personalised outreach briefs with GPT-4o-mini,
 * and sends outreach via Brevo. Saves results to `ugc_leads` table.
 *
 * Scheduler export : runUgcCollector(tenantId, config)
 * Webhook export   : handleUgcCollect(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Score a UGC creator
// ─────────────────────────────────────────────────────────────

function _scoreCreator(creator) {
  const followers   = creator.follower_count || 0;
  const engagement  = creator.engagement_rate || 0; // decimal e.g. 0.04 = 4%
  const isVerified  = creator.is_verified ? 10 : 0;

  // Nano (1K-10K) and micro (10K-100K) get bonus — better engagement ROI
  const followerScore = followers < 1000   ? 5
    : followers < 10000  ? 25
    : followers < 100000 ? 20
    : followers < 500000 ? 15
    : 10;

  const engagementScore = engagement >= 0.08 ? 40
    : engagement >= 0.05 ? 30
    : engagement >= 0.03 ? 20
    : 10;

  return Math.min(100, followerScore + engagementScore + isVerified);
}

// ─────────────────────────────────────────────────────────────
// Generate outreach brief
// ─────────────────────────────────────────────────────────────

async function _generateOutreachBrief(creator, config) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      email_subject: `Collaboration opportunity with ${config.brand_name}`,
      email_body:    `Hi ${creator.username}, we love your content and would love to collaborate!`,
    };
  }

  const prompt = `Write a personalised UGC outreach email from ${config.brand_name} to an Instagram creator.

Creator: @${creator.username}
Followers: ${(creator.follower_count || 0).toLocaleString()}
Engagement rate: ${((creator.engagement_rate || 0) * 100).toFixed(1)}%
Content niche: ${creator.niche || 'lifestyle'}
Brand voice: ${config.brand_voice || 'friendly and authentic'}
Brand: ${config.brand_name} — ${config.product_category || 'D2C products'}

Keep it short (3 paragraphs), authentic, not corporate. Offer a free product + commission.

Return ONLY valid JSON:
{
  "email_subject": "subject line under 55 chars",
  "email_body": "plain text email body",
  "brief_summary": "one-line outreach pitch for internal notes"
}`;

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: config.ai_model_standard || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });

  return JSON.parse(aiRes.data.choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────
// Core handler — process a single UGC lead
// ─────────────────────────────────────────────────────────────

async function handleUgcCollect(tenantId, payload, config) {
  const { username, follower_count, engagement_rate, niche, email, ig_user_id, source } = payload;

  if (!username) return { ok: false, error: 'username required' };

  const score = _scoreCreator({ follower_count, engagement_rate });

  // Dedup — skip if already outreached in last 30 days
  const { data: existing } = await sb()
    .from('ugc_leads')
    .select('id, status')
    .eq('tenant_id', tenantId)
    .eq('username', username)
    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
    .single()
    .catch(() => ({ data: null }));

  if (existing) return { ok: true, workflow: 'SC-01', skipped: true, reason: 'already_contacted' };

  let brief = null;
  let outreachSent = false;

  if (score >= 20 && email) {
    brief = await _generateOutreachBrief({ username, follower_count, engagement_rate, niche }, config).catch(() => null);

    if (brief && process.env.BREVO_API_KEY) {
      try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
          sender:      { name: config.brand_name, email: config.ops_email || process.env.BREVO_SENDER_EMAIL },
          to:          [{ email, name: `@${username}` }],
          subject:     brief.email_subject,
          textContent: brief.email_body,
        }, { headers: { 'api-key': process.env.BREVO_API_KEY } });
        outreachSent = true;
      } catch (err) {
        console.error('[SC-01] Brevo send failed:', err.message);
      }
    }
  }

  // ── Save lead ────────────────────────────────────────────
  await sb().from('ugc_leads').insert({
    tenant_id:       tenantId,
    username,
    ig_user_id:      ig_user_id || null,
    follower_count:  follower_count || 0,
    engagement_rate: engagement_rate || 0,
    niche:           niche || null,
    email:           email || null,
    score,
    source:          source || 'manual',
    brief_summary:   brief?.brief_summary || null,
    outreach_sent:   outreachSent,
    status:          outreachSent ? 'outreached' : (score >= 20 ? 'qualified' : 'low_score'),
    created_at:      new Date().toISOString(),
  }).catch(() => {});

  return {
    ok:            true,
    workflow:      'SC-01',
    username,
    score,
    outreach_sent: outreachSent,
    status:        outreachSent ? 'outreached' : 'qualified',
  };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner — scan Instagram mentions + process queue
// ─────────────────────────────────────────────────────────────

async function runUgcCollector(tenantId, config) {
  const igToken = config.ig_page_token || process.env.INSTAGRAM_ACCESS_TOKEN;
  const igPageId = config.ig_page_id;

  let newMentions = [];

  // Fetch recent mentions from Instagram
  if (igPageId && igToken) {
    try {
      const res = await axios.get(
        `https://graph.facebook.com/v19.0/${igPageId}/tags`,
        { params: { fields: 'id,username,followers_count,media_type', access_token: igToken, limit: 25 } }
      );
      newMentions = (res.data.data || []).map(m => ({
        username:        m.username || m.id,
        ig_user_id:      m.id,
        follower_count:  m.followers_count || 0,
        engagement_rate: 0.03,
        source:          'ig_mention',
      }));
    } catch (err) {
      console.error('[SC-01] Instagram mentions fetch failed:', err.message);
    }
  }

  // Also pull from manual ugc_leads queue (status = 'pending')
  const { data: queued } = await sb()
    .from('ugc_leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .limit(20)
    .catch(() => ({ data: [] }));

  const allLeads = [...newMentions, ...(queued || [])];

  let processed = 0;
  for (const lead of allLeads) {
    try {
      const r = await handleUgcCollect(tenantId, lead, config);
      if (r.ok && !r.skipped) processed++;
    } catch (err) {
      console.error(`[SC-01] Failed for @${lead.username}:`, err.message);
    }
  }

  if (processed > 0) {
    await notify(config, 'ugc_leads', `🎥 UGC scan: ${processed} new creators processed.`, 'info').catch(() => {});
  }
}

module.exports = { handleUgcCollect, runUgcCollector };
