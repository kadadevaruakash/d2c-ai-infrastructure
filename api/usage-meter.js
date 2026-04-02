'use strict';

/**
 * D2C AI Infrastructure — Usage Meter
 *
 * Defines the cost (in credits) of every workflow execution.
 * Provides before/after hooks that wrap the webhookHandler in server.js.
 *
 * Credit costs are based on:
 *  - Number of AI calls (model tier)
 *  - External API calls (Shopify, Instagram, etc.)
 *  - Compute intensity
 *
 * 1 credit = $0.01
 *
 * ── Critical workflows ───────────────────────────────────────
 * These ALWAYS run even if the tenant has zero credits.
 * They protect customer experience and legal compliance.
 * Credits are still deducted (can go negative) — but execution is never blocked.
 */

// ─────────────────────────────────────────────────────────────
// Cost table — credits per execution
// ─────────────────────────────────────────────────────────────

const WORKFLOW_COSTS = {
  // ── ACQUIRE ──────────────────────────────────────────────
  'A-01':  5,   // lead score (1x gpt-4o-mini) + DB write
  'A-02':  4,   // cold email gen (1x gpt-4o-mini) + Brevo send
  'A-03':  3,   // IG intent score (1x gpt-4o-mini) + IG API
  'A-04':  25,  // full SEO package (1x gpt-4o) — premium model

  // ── CONVERT ──────────────────────────────────────────────
  'C-01':  2,   // cart recovery trigger — logic only
  'C-02':  2,   // inventory notify — logic only
  'C-03':  3,   // amazon PDP update — external API
  'C-04':  3,   // gamified checkout + promo code gen

  // ── INTELLIGENCE ─────────────────────────────────────────
  'I-01':  8,   // competitor scrape + AI summary per site
  'I-02':  6,   // multi-source revenue report (GA4 + Shopify + Ads)
  'I-03':  4,   // per-customer RFM + churn score (1x gpt-4o-mini)
  'I-03-SCAN': 15, // cold lead batch scan (full tenant scan)
  'I-04':  10,  // tax/compliance report generation

  // ── RETAIN ───────────────────────────────────────────────
  'R-01':  2,   // CRM tag + welcome email — minimal AI
  'R-02':  2,   // loyalty points calc — no AI
  'R-03':  4,   // social auto-post (1x gpt-4o-mini) + IG API
  'R-04':  4,   // winback email gen (1x gpt-4o-mini)

  // ── SUPPORT ──────────────────────────────────────────────
  'S-01':  3,   // WA support ticket parse + classify
  'S-02':  5,   // RAG query (Pinecone + gpt-4o-mini)
  'S-03':  4,   // review sentiment (1x gpt-4o-mini) + scrape
  'S-04':  2,   // CEO alert aggregation — minimal AI

  // ── SCALE ────────────────────────────────────────────────
  'SC-01': 4,   // UGC collect + DM (IG API + gpt-4o-mini)
  'SC-02': 8,   // funnel analytics (multi-source + summary)
  'SC-03': 5,   // sales qualification (1x gpt-4o-mini)
  'SC-04': 12,  // SEO meta gen (1x gpt-4o) — premium model
};

/**
 * Workflows that always execute regardless of credit balance.
 * Credits are still deducted (can go negative), but never blocked.
 * Add a workflow here only if blocking it would harm the customer
 * or breach an obligation (support, legal, financial).
 */
const CRITICAL_WORKFLOWS = [
  'S-01',  // customer support — never leave a customer hanging
  'S-04',  // CEO emergency alerts
  'C-01',  // cart recovery touch 1 (time-sensitive)
  'I-04',  // tax compliance — legal obligation
];

// ─────────────────────────────────────────────────────────────
// Middleware hooks
// ─────────────────────────────────────────────────────────────

/**
 * Called BEFORE a workflow executes.
 * Returns { allowed, cost_credits, balance, reason }
 *
 * If allowed === false, the workflow should NOT run and the caller
 * should return a 402 response to the webhook.
 */
async function beforeWorkflow(tenantId, workflowId) {
  if (!tenantId || !workflowId) return { allowed: true, cost_credits: 0, reason: 'no_tenant' };

  const cost = WORKFLOW_COSTS[workflowId] || 0;
  if (cost === 0) return { allowed: true, cost_credits: 0, reason: 'free_workflow' };

  const { deductCredits } = require('../shared/credits');
  return deductCredits(tenantId, workflowId, cost);
}

/**
 * Called AFTER a workflow executes.
 * If the execution failed, refund the credits.
 * (Note: deductCredits already ran in beforeWorkflow — this refunds on failure.)
 */
async function afterWorkflow(tenantId, workflowId, success) {
  if (success) return; // nothing to do — credits already deducted

  const cost = WORKFLOW_COSTS[workflowId] || 0;
  if (cost === 0) return;

  // Refund credits on failed execution
  const { addCredits } = require('../shared/credits');
  await addCredits(
    tenantId,
    cost,
    'refund',
    null,
    null
  ).catch(err => console.error('[usage-meter] Refund failed:', err.message));
}

/**
 * Get a formatted summary of workflow costs for display in the UI.
 */
function getWorkflowCostTable() {
  return Object.entries(WORKFLOW_COSTS).map(([id, credits]) => ({
    workflow_id:   id,
    credits,
    cost_usd:      +(credits * 0.01).toFixed(2),
    is_critical:   CRITICAL_WORKFLOWS.includes(id),
  }));
}

module.exports = {
  WORKFLOW_COSTS,
  CRITICAL_WORKFLOWS,
  beforeWorkflow,
  afterWorkflow,
  getWorkflowCostTable,
};
