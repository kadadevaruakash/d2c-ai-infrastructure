const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const axios = require('axios');

async function handleIgDm(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Parse Meta webhook format
  const entry = payload.entry?.[0];
  const messaging = entry?.messaging?.[0];
  if (!messaging) return { success: false, error: 'invalid Meta webhook format' };

  const igsid = messaging.sender?.id;
  const messageText = messaging.message?.text || '';
  if (!igsid || !messageText) return { success: false, error: 'missing igsid or message' };

  const igAccessToken = tenantConfig.instagram_access_token || process.env.INSTAGRAM_ACCESS_TOKEN;

  // AI generate response
  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a friendly D2C brand Instagram DM handler. Engage warmly, qualify intent, guide toward purchase. Keep replies under 200 chars. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Incoming DM: "${messageText}"\nSender IGSID: ${igsid}\n\nReturn JSON:\n{"reply": "string", "intent_score": number, "intent_type": "string", "escalate": boolean}`
    }
  ], 'gpt-4o-mini');

  const analysis = parseAiJson(aiRaw, {
    reply: 'Hi! Thanks for reaching out. How can we help you today? 😊',
    intent_score: 50,
    intent_type: 'general_inquiry',
    escalate: false
  });

  // Send Instagram DM via Graph API
  await axios.post(
    `https://graph.instagram.com/v19.0/me/messages`,
    {
      recipient: { id: igsid },
      message: { text: analysis.reply }
    },
    {
      params: { access_token: igAccessToken },
      headers: { 'Content-Type': 'application/json' }
    }
  );

  // Log interaction
  await sb.from('ig_interactions').insert({
    tenant_id: tenantId,
    igsid,
    message_in: messageText,
    message_out: analysis.reply,
    intent_score: analysis.intent_score,
    intent_type: analysis.intent_type,
    escalated: analysis.escalate,
    timestamp: new Date().toISOString()
  });

  if (analysis.intent_score > 70) {
    await notify(tenantConfig, 'slack_sales_channel', {
      text: `🔥 HIGH INTENT IG DM\n\nIGSID: ${igsid}\nMessage: "${messageText}"\nIntent Score: ${analysis.intent_score}\nIntent Type: ${analysis.intent_type}\nReply sent: "${analysis.reply}"`
    });
  }

  return { success: true, intent_score: analysis.intent_score };
}

module.exports = { handleIgDm };
