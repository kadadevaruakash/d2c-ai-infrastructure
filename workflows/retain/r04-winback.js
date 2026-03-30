const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { getAtRiskCustomers } = require('../../shared/customer');
const { sendWinbackEmail } = require('../../shared/email');
const { notify } = require('../../shared/notification');

async function runWinbackCampaign(tenantId, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Get at-risk customers (60+ days inactive, winback_sent=false)
  const atRisk = await getAtRiskCustomers(tenantId, { days_inactive: 60 });
  if (!atRisk || atRisk.length === 0) return { processed: 0 };

  let sent = 0;
  const errors = [];

  for (const customer of atRisk) {
    try {
      // Determine winback stage (1=first attempt, 2=follow up, 3=final)
      const winbackCount = customer.winback_count || 0;
      const stage = Math.min(winbackCount + 1, 3);

      const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
        {
          role: 'system',
          content: 'You are a customer retention specialist. Write a personalized winback email. Be genuine, not spammy. Offer value. Return ONLY JSON.'
        },
        {
          role: 'user',
          content: `Customer: ${customer.first_name || 'there'}\nDays Inactive: ${customer.days_inactive || 60}\nPrevious Orders: ${customer.orders_count || 0}\nTotal Spent: $${customer.total_spent || 0}\nWinback Stage: ${stage}/3\nLast Purchase Category: ${customer.last_category || 'unknown'}\n\nReturn JSON:\n{"subject": "string", "preview": "string", "body": "string", "offer": "string (e.g. 15% off)", "urgency": "low|medium|high"}`
        }
      ], 'gpt-4o-mini');

      const email = parseAiJson(aiRaw, {
        subject: `We miss you, ${customer.first_name || 'there'}!`,
        preview: 'A special offer just for you',
        body: `Hi ${customer.first_name || 'there'},\n\nWe haven't seen you in a while and wanted to reach out.\n\nWe'd love to have you back — here's a special offer just for you.`,
        offer: stage === 1 ? '10% off' : stage === 2 ? '15% off' : '20% off + free shipping',
        urgency: stage === 3 ? 'high' : 'medium'
      });

      await sendWinbackEmail(tenantConfig, {
        to: customer.email,
        first_name: customer.first_name,
        subject: email.subject,
        body: email.body,
        offer: email.offer,
        stage
      });

      // Update customer winback status
      await sb.from('customers')
        .update({
          winback_sent: stage >= 3,
          winback_count: stage,
          last_winback_at: new Date().toISOString()
        })
        .eq('customer_id', customer.customer_id)
        .eq('tenant_id', tenantId);

      // Log campaign
      await sb.from('winback_campaigns').insert({
        tenant_id: tenantId,
        customer_id: customer.customer_id,
        stage,
        subject: email.subject,
        offer: email.offer,
        sent_at: new Date().toISOString()
      });

      sent++;
    } catch (err) {
      errors.push({ customer_id: customer.customer_id, error: err.message });
    }
  }

  if (sent > 0) {
    await notify(tenantConfig, 'slack_cx_channel', {
      text: `💌 WINBACK CAMPAIGN SENT\n\nAt-Risk Customers: ${atRisk.length}\nEmails Sent: ${sent}\nErrors: ${errors.length}`
    });
  }

  return { processed: atRisk.length, sent, errors };
}

module.exports = { runWinbackCampaign };
