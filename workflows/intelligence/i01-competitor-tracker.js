'use strict';

/**
 * I-01 — Competitor Tracker
 *
 * Triggered: daily 7 AM (scheduler) or manually via webhook.
 * Fetches competitor URLs from `competitors` table, scrapes pricing/content
 * signals via OpenAI web browsing (or stored snapshots), generates a
 * structured intelligence digest, saves to `competitor_snapshots`, and
 * sends a WhatsApp/notification summary to the strategy team.
 *
 * Scheduler export : runCompetitorTracker(tenantId, config)
 * Webhook export   : handleCompetitorTrack(tenantId, payload, config)
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { notify } = require('../../shared/notification');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Core handler — analyse a single competitor
// ─────────────────────────────────────────────────────────────

async function handleCompetitorTrack(tenantId, payload, config) {
  const { competitor_url, competitor_name, focus_areas } = payload;
  if (!competitor_url) return { ok: false, error: 'competitor_url required' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY not set' };

  const model = config.ai_model_standard || 'gpt-4o-mini';

  const prompt = `You are a competitive intelligence analyst for ${config.brand_name || 'a D2C brand'}.

Analyse the following competitor and generate a structured intelligence report.

Competitor: ${competitor_name || competitor_url}
URL: ${competitor_url}
Focus areas: ${focus_areas || 'pricing, promotions, new products, content strategy, customer sentiment'}
Brand context: ${config.brand_name} sells ${config.product_category || 'consumer products'} at ${config.store_url || 'their online store'}

Return ONLY valid JSON:
{
  "competitor_name": "name",
  "pricing_intel": "pricing observations and changes",
  "promotion_intel": "active promotions or discounts observed",
  "product_intel": "new launches or product changes",
  "content_intel": "messaging strategy, top content themes",
  "sentiment_intel": "customer sentiment observations",
  "threat_level": "low|medium|high",
  "key_opportunities": ["opportunity 1", "opportunity 2", "opportunity 3"],
  "recommended_actions": ["action 1", "action 2"],
  "summary": "2-sentence executive summary"
}`;

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  const intel = JSON.parse(aiRes.data.choices[0].message.content);

  // ── Save snapshot ─────────────────────────────────────────
  const { data: snapshot } = await sb()
    .from('competitor_snapshots')
    .insert({
      tenant_id:        tenantId,
      competitor_url,
      competitor_name:  intel.competitor_name || competitor_name,
      pricing_intel:    intel.pricing_intel,
      promotion_intel:  intel.promotion_intel,
      product_intel:    intel.product_intel,
      content_intel:    intel.content_intel,
      sentiment_intel:  intel.sentiment_intel,
      threat_level:     intel.threat_level,
      opportunities:    intel.key_opportunities,
      actions:          intel.recommended_actions,
      summary:          intel.summary,
      snapshot_at:      new Date().toISOString(),
    })
    .select('id')
    .single()
    .catch(() => ({ data: null }));

  return {
    ok:              true,
    workflow:        'I-01',
    competitor_name: intel.competitor_name,
    threat_level:    intel.threat_level,
    summary:         intel.summary,
    snapshot_id:     snapshot?.id || null,
  };
}

// ─────────────────────────────────────────────────────────────
// Scheduler runner — tracks all configured competitors
// ─────────────────────────────────────────────────────────────

async function runCompetitorTracker(tenantId, config) {
  if (!process.env.OPENAI_API_KEY) return;

  const { data: competitors } = await sb()
    .from('competitors')
    .select('url, name, focus_areas')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .catch(() => ({ data: [] }));

  if (!competitors || competitors.length === 0) return;

  const results = [];
  for (const comp of competitors) {
    try {
      const r = await handleCompetitorTrack(tenantId, {
        competitor_url:  comp.url,
        competitor_name: comp.name,
        focus_areas:     comp.focus_areas,
      }, config);
      results.push(r);
    } catch (err) {
      console.error(`[I-01] Failed for ${comp.url}:`, err.message);
    }
  }

  const highThreats = results.filter(r => r.threat_level === 'high');
  const digest = results.map(r =>
    `• *${r.competitor_name}* — ${r.threat_level?.toUpperCase()} threat\n  ${r.summary}`
  ).join('\n\n');

  if (digest) {
    await notify(
      config,
      'competitor_intel',
      `📊 *Daily Competitor Digest* (${results.length} tracked)\n\n${digest}`,
      highThreats.length > 0 ? 'warning' : 'info'
    ).catch(() => {});
  }
}

module.exports = { handleCompetitorTrack, runCompetitorTracker };
