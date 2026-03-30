const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');

async function handleLeadCapture(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { name, email, source, phone, notes } = payload;
  if (!name || !email) {
    return { success: false, error: 'name and email required' };
  }

  // AI score lead
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a lead scoring expert. Score this lead 0-100 and classify as hot/warm/cold. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Name: ${name}\nEmail: ${email}\nSource: ${source || 'unknown'}\nPhone: ${phone || 'none'}\nNotes: ${notes || ''}\n\nReturn JSON:\n{"score": number, "classification": "hot|warm|cold", "reason": "string", "next_action": "string"}`
    }
  ], 'gpt-4o-mini');

  const analysis = parseAiJson(aiRaw, {
    score: 50,
    classification: 'warm',
    reason: 'Default scoring',
    next_action: 'Follow up via email'
  });

  const leadId = 'LEAD-' + Date.now();
  const { error } = await sb.from('leads').insert({
    lead_id: leadId,
    tenant_id: tenantId,
    name,
    email,
    phone: phone || null,
    source: source || 'direct',
    score: analysis.score,
    classification: analysis.classification,
    reason: analysis.reason,
    next_action: analysis.next_action,
    notes: notes || null,
    status: 'new',
    created_at: new Date().toISOString()
  });

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);

  if (analysis.classification === 'hot') {
    await notify(tenantConfig, 'slack_sales_channel', {
      text: `🔥 HOT LEAD CAPTURED\n\nName: ${name}\nEmail: ${email}\nScore: ${analysis.score}/100\nSource: ${source || 'direct'}\nNext Action: ${analysis.next_action}`
    });
  }

  return { lead_id: leadId, score: analysis.score, classification: analysis.classification };
}

module.exports = { handleLeadCapture };
