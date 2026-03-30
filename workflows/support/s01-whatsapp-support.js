const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { getCustomer } = require('../../shared/customer');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function handleWhatsAppSupport(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Parse Meta WA webhook
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return { success: false, error: 'no message in payload' };

  const phone = message.from;
  const messageText = message.text?.body || message.type || '';
  const waPhoneId = change?.value?.metadata?.phone_number_id;

  // Get customer and chat history in parallel
  const [customer, historyResult] = await Promise.all([
    getCustomer(tenantId, { phone }),
    sb.from('support_interactions')
      .select('message_in, message_out, created_at')
      .eq('tenant_id', tenantId)
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(10)
  ]);

  const history = historyResult.data || [];

  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: `You are a helpful customer support agent for ${tenantConfig.brand_name || 'our brand'}. Be friendly, empathetic, and resolve issues efficiently. Escalate if needed. Return ONLY JSON.`
    },
    {
      role: 'user',
      content: `Customer: ${customer ? `${customer.first_name} (${customer.rfm_segment || 'unknown'} tier)` : 'Unknown'}\nPhone: ${phone}\nMessage: "${messageText}"\nChat History: ${JSON.stringify(history.map(h => ({ in: h.message_in, out: h.message_out })).slice(0, 5))}\n\nReturn JSON:\n{"reply": "string (max 1000 chars)", "sentiment": "positive|neutral|negative", "issue_category": "string", "escalate": boolean, "escalation_reason": "string|null", "resolved": boolean}`
    }
  ], 'gpt-4o-mini');

  const response = parseAiJson(aiRaw, {
    reply: 'Hi! Thank you for reaching out. How can I help you today?',
    sentiment: 'neutral',
    issue_category: 'general_inquiry',
    escalate: false,
    escalation_reason: null,
    resolved: false
  });

  // Send WhatsApp reply
  const waToken = tenantConfig.whatsapp_token || process.env.WHATSAPP_TOKEN;
  const sendPhoneId = tenantConfig.whatsapp_phone_id || waPhoneId || process.env.WHATSAPP_PHONE_ID;

  await axios.post(
    `https://graph.facebook.com/v18.0/${sendPhoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: response.reply }
    },
    { headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' } }
  );

  // Log interaction
  await sb.from('support_interactions').insert({
    tenant_id: tenantId,
    phone,
    customer_id: customer?.customer_id || null,
    channel: 'whatsapp',
    message_in: messageText,
    message_out: response.reply,
    sentiment: response.sentiment,
    issue_category: response.issue_category,
    escalated: response.escalate,
    resolved: response.resolved,
    created_at: new Date().toISOString()
  });

  if (response.escalate) {
    await notify(tenantConfig, 'slack_cx_channel', {
      text: `🚨 WHATSAPP ESCALATION\n\nPhone: ${phone}\nCustomer: ${customer?.first_name || 'Unknown'}\nReason: ${response.escalation_reason}\nMessage: "${messageText}"\nCategory: ${response.issue_category}`
    });
  }

  return { success: true, resolved: response.resolved, escalated: response.escalate };
}

module.exports = { handleWhatsAppSupport };
