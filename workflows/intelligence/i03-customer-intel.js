const { createClient } = require('@supabase/supabase-js');
const { callOpenAI, parseAiJson } = require('../../shared/ai-client');
const { getCustomer, upsertCustomer } = require('../../shared/customer');
const { notify } = require('../../shared/notification');

async function handleCustomerIntel(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { customer_id, interaction_type, channel, content, metadata } = payload;
  if (!customer_id) return { success: false, error: 'customer_id required' };

  // Get customer and interaction history in parallel
  const [customer, historyResult] = await Promise.all([
    getCustomer(tenantId, { customer_id }),
    sb.from('customer_interactions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('customer_id', customer_id)
      .order('created_at', { ascending: false })
      .limit(20)
  ]);

  const history = historyResult.data || [];

  const aiRaw = await callOpenAI(tenantConfig.openai_api_key || process.env.OPENAI_API_KEY, [
    {
      role: 'system',
      content: 'You are a customer intelligence analyst. Analyze customer behavior and predict churn risk. Return ONLY JSON.'
    },
    {
      role: 'user',
      content: `Customer ID: ${customer_id}\nCustomer Data: ${JSON.stringify(customer || {})}\nInteraction Type: ${interaction_type}\nChannel: ${channel}\nContent: ${content || ''}\nHistory (last 20): ${JSON.stringify(history.map(h => ({ type: h.interaction_type, channel: h.channel, date: h.created_at })))}\n\nReturn JSON:\n{"rfm_segment": "champions|loyal|at_risk|lost|new", "churn_probability": number (0-1), "lifetime_value_estimate": number, "next_best_action": "string", "sentiment": "positive|neutral|negative", "key_interests": ["string"]}`
    }
  ], 'gpt-4o-mini');

  const analysis = parseAiJson(aiRaw, {
    rfm_segment: 'new',
    churn_probability: 0.3,
    lifetime_value_estimate: 0,
    next_best_action: 'Send welcome sequence',
    sentiment: 'neutral',
    key_interests: []
  });

  // Log interaction
  await sb.from('customer_interactions').insert({
    tenant_id: tenantId,
    customer_id,
    interaction_type: interaction_type || 'unknown',
    channel: channel || 'unknown',
    content: content || null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    sentiment: analysis.sentiment,
    created_at: new Date().toISOString()
  });

  // Upsert customer intelligence
  await upsertCustomer(tenantId, {
    customer_id,
    rfm_segment: analysis.rfm_segment,
    churn_probability: analysis.churn_probability,
    lifetime_value_estimate: analysis.lifetime_value_estimate,
    next_best_action: analysis.next_best_action,
    key_interests: JSON.stringify(analysis.key_interests),
    last_intel_at: new Date().toISOString()
  });

  if (analysis.churn_probability > 0.7) {
    await notify(tenantConfig, 'slack_cx_channel', {
      text: `🚨 HIGH CHURN RISK\n\nCustomer ID: ${customer_id}\nChurn Probability: ${(analysis.churn_probability * 100).toFixed(0)}%\nSegment: ${analysis.rfm_segment}\nNext Action: ${analysis.next_best_action}\nSentiment: ${analysis.sentiment}`
    });
  }

  return {
    customer_id,
    rfm_segment: analysis.rfm_segment,
    churn_probability: analysis.churn_probability,
    next_best_action: analysis.next_best_action
  };
}

module.exports = { handleCustomerIntel };
