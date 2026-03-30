const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { sendColdEmail } = require('../../shared/email');
const { notify } = require('../../shared/notification');

async function runColdEmailCampaign(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: prospects, error } = await sb
    .from('prospects')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('email_sent', false)
    .limit(50);

  if (error) throw new Error(`Fetch prospects failed: ${error.message}`);
  if (!prospects || prospects.length === 0) return { sent: 0 };

  let sent = 0;
  const errors = [];

  for (const prospect of prospects) {
    try {
      const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
        {
          role: 'system',
          content: 'You are a cold email specialist. Write a personalized, concise cold email. No fluff. Max 150 words. Return ONLY JSON.'
        },
        {
          role: 'user',
          content: `Prospect: ${prospect.name}\nCompany: ${prospect.company || 'unknown'}\nIndustry: ${prospect.industry || 'unknown'}\nPain point: ${prospect.pain_point || 'growth'}\n\nReturn JSON:\n{"subject": "string", "body": "string", "cta": "string"}`
        }
      ], 'gpt-4o-mini');

      const email = parseAiJson(aiRaw, {
        subject: `Quick question for ${prospect.name}`,
        body: `Hi ${prospect.name},\n\nI noticed your company might benefit from our platform. Would you be open to a quick chat?\n\nBest,\nThe Team`,
        cta: 'Schedule a 15-min call'
      });

      await sendColdEmail(tenantConfig, {
        to: prospect.email,
        subject: email.subject,
        body: email.body,
        cta: email.cta,
        prospect_name: prospect.name
      });

      await sb.from('prospects')
        .update({ email_sent: true, email_sent_at: new Date().toISOString(), email_subject: email.subject })
        .eq('id', prospect.id)
        .eq('tenant_id', tenantId);

      sent++;
    } catch (err) {
      errors.push({ prospect_id: prospect.id, error: err.message });
    }
  }

  if (sent > 0) {
    await notify(tenantConfig, 'slack_sales_channel', {
      text: `📧 COLD EMAIL CAMPAIGN RUN\n\nSent: ${sent}/${prospects.length}\nErrors: ${errors.length}\nDate: ${new Date().toISOString()}`
    });
  }

  return { sent, errors };
}

module.exports = { runColdEmailCampaign };
