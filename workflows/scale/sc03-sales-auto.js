const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { sendSalesFollowUp } = require('../../shared/email');
const { notify } = require('../../shared/notification');

async function handleSalesSignal(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { customer_id, signal_type, signal_data, source } = payload;
  if (!customer_id) return { success: false, error: 'customer_id required' };

  // Get customer profile
  const { data: customerData } = await sb
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customer_id)
    .limit(1);

  const customer = customerData?.[0];

  // AI qualify signal and determine next action
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a D2C sales automation specialist. Qualify intent signals and determine the best automated response. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Customer ID: ${customer_id}\nCustomer Data: ${JSON.stringify(customer || {})}\nSignal Type: ${signal_type}\nSignal Data: ${JSON.stringify(signal_data || {})}\nSource: ${source || 'unknown'}\n\nReturn JSON:\n{"intent_score": number (0-100), "qualified": boolean, "action": "send_email|schedule_call|add_to_sequence|no_action", "email_subject": "string", "email_body": "string", "include_calendly": boolean, "sequence_name": "string|null"}`
    }
  ], 'gpt-4o-mini');

  const qualification = parseAiJson(aiRaw, {
    intent_score: 50,
    qualified: false,
    action: 'no_action',
    email_subject: 'Following up on your interest',
    email_body: 'Hi there, thanks for your interest!',
    include_calendly: false,
    sequence_name: null
  });

  // Store automation record
  const automationId = 'AUTO-' + Date.now();
  await sb.from('sales_automations').insert({
    automation_id: automationId,
    tenant_id: tenantId,
    customer_id,
    signal_type,
    signal_data: JSON.stringify(signal_data || {}),
    intent_score: qualification.intent_score,
    qualified: qualification.qualified,
    action: qualification.action,
    status: 'pending',
    created_at: new Date().toISOString()
  });

  // Execute action
  if (qualification.qualified && qualification.action === 'send_email' && customer?.email) {
    const calendlyLink = tenantConfig.calendly_link || process.env.CALENDLY_LINK;

    await sendSalesFollowUp(tenantConfig, {
      to: customer.email,
      first_name: customer.first_name || 'there',
      subject: qualification.email_subject,
      body: qualification.email_body,
      include_calendly: qualification.include_calendly,
      calendly_link: calendlyLink
    });

    await sb.from('sales_automations')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('automation_id', automationId)
      .eq('tenant_id', tenantId);

    if (qualification.intent_score >= 70) {
      await notify(tenantConfig, 'slack_sales_channel', {
        text: `🎯 HIGH INTENT SIGNAL\n\nCustomer: ${customer?.first_name || customer_id}\nSignal: ${signal_type}\nIntent Score: ${qualification.intent_score}/100\nAction: ${qualification.action}\nEmail sent with${qualification.include_calendly ? '' : 'out'} Calendly link`
      });
    }
  }

  return {
    automation_id: automationId,
    intent_score: qualification.intent_score,
    qualified: qualification.qualified,
    action: qualification.action
  };
}

module.exports = { handleSalesSignal };
