/**
 * D2C AI Infrastructure — Shared AI Client
 *
 * Eliminates the 24x duplicated JSON parse try/catch pattern.
 * Provides a single, consistent interface for all AI calls across workflows.
 *
 * In n8n code nodes, paste the relevant snippet from the bottom of this file.
 * For Node.js API usage, require() this module directly.
 */

'use strict';

// ──────────────────────────────────────────────
// Safe JSON parser (replaces the duplicated try/catch in all 24 workflows)
// ──────────────────────────────────────────────

/**
 * Safely parse AI response JSON with a typed fallback.
 * @param {string} aiResponseText  - Raw text from OpenAI/Anthropic
 * @param {object} fallback        - Default object if parse fails
 * @returns {object}
 */
function parseAiJson(aiResponseText, fallback = {}) {
  if (!aiResponseText) return fallback;

  // Strip markdown code fences if present (GPT sometimes wraps in ```json)
  const cleaned = aiResponseText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    return fallback;
  }
}

// ──────────────────────────────────────────────
// OpenAI caller (for use in Node.js API layer, not n8n)
// n8n has its own native OpenAI node — this is for server-side calls
// ──────────────────────────────────────────────

async function callOpenAI({ systemPrompt, userPrompt, model, jsonMode = true }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    response_format: jsonMode ? { type: 'json_object' } : undefined,
  });

  const text = response.choices[0]?.message?.content || '';
  return jsonMode ? parseAiJson(text) : text;
}

// ──────────────────────────────────────────────
// Anthropic Claude caller (optional AI provider)
// ──────────────────────────────────────────────

async function callClaude({ systemPrompt, userPrompt, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: model || 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return message.content[0]?.text || '';
}

// ──────────────────────────────────────────────
// n8n CODE NODE SNIPPETS
// Copy-paste these into n8n Code nodes to replace the duplicated pattern
// ──────────────────────────────────────────────
//
// SNIPPETS:
//   - Replace the 8-line try/catch pattern with parseAiJson
//   - Load tenant_config via GET /api/config/{{ tenantSlug }}
//   - Use /webhook/shared-notify for centralized Slack notifications
//
module.exports = { parseAiJson, callOpenAI, callClaude };
