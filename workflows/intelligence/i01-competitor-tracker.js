const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function runCompetitorTracker(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: competitors, error } = await sb
    .from('competitors')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('active', true);

  if (error) throw new Error(`Fetch competitors failed: ${error.message}`);
  if (!competitors || competitors.length === 0) return { processed: 0 };

  let processed = 0;
  let alerts = 0;

  for (const competitor of competitors) {
    try {
      // Scrape competitor website (basic HTTP fetch)
      let websiteContent = '';
      try {
        const res = await axios.get(competitor.website_url, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot/1.0)' }
        });
        // Strip HTML tags and truncate
        websiteContent = res.data
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 3000);
      } catch (err) {
        websiteContent = `Unable to scrape: ${err.message}`;
      }

      const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
        {
          role: 'system',
          content: 'You are a competitive intelligence analyst. Detect significant changes in competitor positioning, pricing, products, or messaging. Return ONLY JSON.'
        },
        {
          role: 'user',
          content: `Competitor: ${competitor.name}\nURL: ${competitor.website_url}\nLast Known State: ${competitor.last_snapshot || 'no prior data'}\nCurrent Content:\n${websiteContent}\n\nReturn JSON:\n{"has_changes": boolean, "changes_detected": ["string"], "threat_level": "low|medium|high", "summary": "string", "recommended_action": "string"}`
        }
      ], 'gpt-4o-mini');

      const analysis = parseAiJson(aiRaw, {
        has_changes: false,
        changes_detected: [],
        threat_level: 'low',
        summary: 'No significant changes detected',
        recommended_action: 'Continue monitoring'
      });

      if (analysis.has_changes) {
        await sb.from('competitor_alerts').insert({
          tenant_id: tenantId,
          competitor_id: competitor.id,
          competitor_name: competitor.name,
          changes: JSON.stringify(analysis.changes_detected),
          threat_level: analysis.threat_level,
          summary: analysis.summary,
          recommended_action: analysis.recommended_action,
          created_at: new Date().toISOString()
        });

        await notify(tenantConfig, 'slack_strategy_channel', {
          text: `🕵️ COMPETITOR CHANGE DETECTED\n\nCompetitor: ${competitor.name}\nThreat Level: ${analysis.threat_level.toUpperCase()}\nChanges: ${analysis.changes_detected.join(', ')}\nSummary: ${analysis.summary}\nAction: ${analysis.recommended_action}`
        });

        if (analysis.threat_level === 'high') {
          await notify(tenantConfig, 'email_strategy', {
            subject: `🚨 High-Threat Competitor Change: ${competitor.name}`,
            text: `${analysis.summary}\n\nRecommended Action: ${analysis.recommended_action}\n\nChanges Detected:\n${analysis.changes_detected.join('\n')}`
          });
        }

        alerts++;
      }

      // Update snapshot
      await sb.from('competitors')
        .update({ last_snapshot: websiteContent.substring(0, 500), last_checked_at: new Date().toISOString() })
        .eq('id', competitor.id)
        .eq('tenant_id', tenantId);

      processed++;
    } catch (err) {
      console.error(`Competitor tracking failed for ${competitor.name}:`, err.message);
    }
  }

  return { processed, alerts };
}

module.exports = { runCompetitorTracker };
