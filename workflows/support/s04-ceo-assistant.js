const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function handleCeoAlert(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { incident_type, severity, description, data, source } = payload;
  if (!incident_type) return { success: false, error: 'incident_type required' };

  // Get team availability and AI brief in parallel
  const [availabilityResult, aiRaw] = await Promise.all([
    sb.from('team_availability')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('available', true),
    callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
      {
        role: 'system',
        content: 'You are a C-suite executive assistant. Create a concise, actionable incident brief for the CEO. No fluff. Prioritize decisions needed. Return ONLY JSON.'
      },
      {
        role: 'user',
        content: `Incident Type: ${incident_type}\nSeverity: ${severity || 'unknown'}\nDescription: ${description || ''}\nData: ${JSON.stringify(data || {})}\nSource: ${source || 'system'}\nTime: ${new Date().toISOString()}\n\nReturn JSON:\n{"headline": "string (max 100 chars)", "summary": "string (max 500 chars)", "impact": "string", "immediate_actions": ["string"], "decisions_needed": ["string"], "estimated_resolution": "string"}`
      }
    ], 'gpt-4o')
  ]);

  const team = availabilityResult.data || [];
  const brief = parseAiJson(aiRaw, {
    headline: `${incident_type} — Severity: ${severity || 'unknown'}`,
    summary: description || 'Incident requires attention',
    impact: 'Impact assessment pending',
    immediate_actions: ['Assess situation', 'Notify relevant teams'],
    decisions_needed: ['Review incident details'],
    estimated_resolution: 'TBD'
  });

  // Send WhatsApp to CEO if configured
  const ceoPhone = tenantConfig.ceo_phone || process.env.CEO_PHONE;
  if (ceoPhone) {
    try {
      const waToken = tenantConfig.whatsapp_token || process.env.WHATSAPP_TOKEN;
      const waPhoneId = tenantConfig.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
      await axios.post(
        `https://graph.facebook.com/v18.0/${waPhoneId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: ceoPhone,
          type: 'text',
          text: {
            body: `🚨 CEO ALERT\n\n${brief.headline}\n\n${brief.summary}\n\nImpact: ${brief.impact}\n\nActions Needed:\n${brief.immediate_actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nDecisions Required:\n${brief.decisions_needed.join('\n')}`
          }
        },
        { headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('CEO WhatsApp alert failed:', err.message);
    }
  }

  // Slack alert
  await notify(tenantConfig, 'slack_leadership_channel', {
    text: `🚨 CEO INCIDENT ALERT\n\n*${brief.headline}*\n\n${brief.summary}\n\nImpact: ${brief.impact}\n\nImmediate Actions:\n${brief.immediate_actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nDecisions Needed:\n${brief.decisions_needed.join('\n')}\n\nEstimated Resolution: ${brief.estimated_resolution}\n\nAvailable Team Members: ${team.map(t => t.name).join(', ') || 'None flagged'}`
  });

  // Log alert
  const alertId = 'CEO-' + Date.now();
  await sb.from('ceo_alerts').insert({
    alert_id: alertId,
    tenant_id: tenantId,
    incident_type,
    severity: severity || 'unknown',
    headline: brief.headline,
    summary: brief.summary,
    impact: brief.impact,
    immediate_actions: JSON.stringify(brief.immediate_actions),
    decisions_needed: JSON.stringify(brief.decisions_needed),
    wa_sent: !!ceoPhone,
    slack_sent: true,
    created_at: new Date().toISOString()
  });

  return { alert_id: alertId, headline: brief.headline, wa_sent: !!ceoPhone };
}

module.exports = { handleCeoAlert };
