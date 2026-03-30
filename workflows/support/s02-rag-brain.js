const { createClient } = require('@supabase/supabase-js');
const { callOpenAI } = require('../../shared/ai-client');
const { notify } = require('../../shared/notification');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');

async function handleRagQuery(tenantId, payload, tenantConfig) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { query, customer_id, channel, session_id } = payload;
  if (!query) return { success: false, error: 'query required' };

  const openaiKey = tenantConfig.openai_api_key || process.env.OPENAI_API_KEY;
  const pineconeKey = tenantConfig.pinecone_api_key || process.env.PINECONE_API_KEY;
  const pineconeIndex = tenantConfig.pinecone_index || process.env.PINECONE_INDEX || 'knowledge-base';

  // Generate embedding for query
  const openaiClient = new OpenAI({ apiKey: openaiKey });
  const embeddingRes = await openaiClient.embeddings.create({
    model: 'text-embedding-3-small',
    input: query
  });
  const queryEmbedding = embeddingRes.data[0].embedding;

  // Search Pinecone for top 3 relevant docs
  let contextDocs = [];
  let citations = [];

  try {
    const pc = new Pinecone({ apiKey: pineconeKey });
    const index = pc.index(pineconeIndex);
    const searchRes = await index.query({
      vector: queryEmbedding,
      topK: 3,
      filter: { tenant_id: tenantId },
      includeMetadata: true
    });

    contextDocs = searchRes.matches || [];
    citations = contextDocs.map(m => ({
      source: m.metadata?.source || 'Knowledge Base',
      title: m.metadata?.title || 'Document',
      score: m.score
    }));
  } catch (err) {
    console.error('Pinecone search failed:', err.message);
  }

  const context = contextDocs
    .map(m => m.metadata?.text || '')
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Generate answer with context
  const messages = [
    {
      role: 'system',
      content: `You are a knowledgeable support agent for ${tenantConfig.brand_name || 'our brand'}. Answer questions accurately using the provided knowledge base. If unsure, say so. Return ONLY JSON.`
    },
    {
      role: 'user',
      content: `Question: "${query}"\n\nKnowledge Base Context:\n${context || 'No relevant documents found.'}\n\nReturn JSON:\n{"answer": "string", "confidence": number (0-1), "escalate": boolean, "escalation_reason": "string|null", "follow_up_suggestions": ["string"]}`
    }
  ];

  const aiResponse = await callOpenAI(openaiKey, messages, 'gpt-4o-mini');
  let analysis;

  try {
    const cleaned = (typeof aiResponse === 'string' ? aiResponse : aiResponse?.content || '')
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    analysis = JSON.parse(cleaned);
  } catch {
    analysis = {
      answer: context ? `Based on our knowledge base: ${context.substring(0, 500)}` : "I don't have specific information on that. Let me connect you with our team.",
      confidence: 0.3,
      escalate: true,
      escalation_reason: 'AI parse failure',
      follow_up_suggestions: []
    };
  }

  // Log query
  const queryId = 'QRY-' + Date.now();
  await sb.from('rag_queries').insert({
    query_id: queryId,
    tenant_id: tenantId,
    customer_id: customer_id || null,
    channel: channel || 'api',
    session_id: session_id || null,
    query,
    answer: analysis.answer,
    confidence: analysis.confidence,
    citations: JSON.stringify(citations),
    escalated: analysis.escalate,
    created_at: new Date().toISOString()
  });

  if (analysis.escalate) {
    await notify(tenantConfig, 'slack_cx_channel', {
      text: `🤔 RAG ESCALATION\n\nQuery: "${query}"\nConfidence: ${(analysis.confidence * 100).toFixed(0)}%\nReason: ${analysis.escalation_reason}\nChannel: ${channel || 'api'}`
    });
  }

  return {
    answer: analysis.answer,
    confidence: analysis.confidence,
    citations,
    escalate: analysis.escalate,
    follow_up_suggestions: analysis.follow_up_suggestions || [],
    query_id: queryId
  };
}

module.exports = { handleRagQuery };
