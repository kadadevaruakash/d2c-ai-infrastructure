'use strict';

const EventEmitter = require('events');

// ── Global SSE bus — one channel per tenant ──────────
const orchestratorEvents = new EventEmitter();
orchestratorEvents.setMaxListeners(500);

// ── Cascade Map ──────────────────────────────────────
// Each entry: { triggers, label, condition(result,input)=>bool, payload(result,input,cfg)=>obj }
// result   = what the upstream workflow returned
// input    = the raw payload that was fed into the upstream workflow
// cfg      = full tenantConfig object

const CASCADE_MAP = {

  // ── ACQUIRE ──────────────────────────────────────
  'A-01': [
    {
      triggers: 'SC-03',
      label: 'Hot lead → immediate sales follow-up',
      condition: (r) => r.classification === 'hot',
      payload: (r, p) => ({
        intent: 'high',
        name: p.name || 'Unknown',
        email: p.email,
        source: 'lead_capture',
        signal: `Hot lead scored ${r.score}/100 via ${p.source || 'direct'}`,
      }),
    },
  ],

  // ── CONVERT ──────────────────────────────────────
  'C-01': [
    {
      triggers: 'I-03',
      label: 'Repeated cart abandonment → update churn intel',
      condition: (r) => (r.abandonment_count || 0) > 1,
      payload: (r, p) => ({
        event_type: 'repeated_abandonment',
        customer_id: r.customer_id || p.customer?.id,
        email: p.customer?.email || p.email,
        metadata: { cart_value: p.total_price, abandonments: r.abandonment_count },
      }),
    },
  ],

  'C-04': [
    {
      triggers: 'I-03',
      label: 'Gamified checkout engaged → customer intel event',
      condition: () => true,
      payload: (r, p) => ({
        event_type: 'gamification_engaged',
        customer_id: p.customer?.id || p.customerId,
        email: p.customer?.email || p.email,
        metadata: { game_type: r.game_type, discount: r.discount_value },
      }),
    },
  ],

  // ── RETAIN ───────────────────────────────────────
  'R-01': [
    {
      triggers: 'R-02',
      label: 'New order → award loyalty points',
      condition: () => true,
      payload: (r, p) => ({
        event_type: 'purchase',
        customer_id: r.customer_id,
        email: p.customer?.email || p.email,
        value: parseFloat(p.total_price || 0),
      }),
    },
    {
      triggers: 'I-03',
      label: 'New order → refresh customer intel profile',
      condition: () => true,
      payload: (r, p) => ({
        event_type: 'purchase',
        customer_id: r.customer_id,
        email: p.customer?.email || p.email,
        metadata: { order_value: p.total_price, rfm_segment: r.rfm_segment },
      }),
    },
  ],

  'R-02': [
    {
      triggers: 'S-04',
      label: 'Tier upgraded → CEO/ops awareness',
      condition: (r) => r.tier_upgraded === true,
      payload: (r, p) => ({
        incident: `Customer ${p.email || p.customer_id} upgraded to ${r.new_tier} tier`,
        severity: 'low',
        source: 'loyalty_engine',
      }),
    },
  ],

  // ── INTELLIGENCE ─────────────────────────────────
  'I-03': [
    {
      triggers: 'R-04',
      label: 'High churn risk detected → start winback campaign',
      condition: (r) => (r.churn_risk_score || 0) >= 0.7,
      payload: (r, p) => ({
        customer_id: r.customer_id || p.customer_id,
        email: r.email || p.email,
        churn_risk: r.churn_risk_score,
        segment: r.segment,
        reason: r.churn_reason || 'Predicted churn from intel model',
      }),
    },
  ],

  // ── SUPPORT ──────────────────────────────────────
  'S-01': [
    {
      triggers: 'S-02',
      label: 'Support query → RAG knowledge lookup',
      condition: (r) => r.needs_knowledge_lookup === true,
      payload: (r, p) => ({
        query: r.question || p.message,
        customer_id: r.customer_id || p.customer_id,
        context: r.conversation_context,
      }),
    },
    {
      triggers: 'S-04',
      label: 'Escalated ticket → executive alert',
      condition: (r) => r.escalated === true,
      payload: (r, p) => ({
        incident: r.escalation_summary || `Escalated WhatsApp ticket: "${p.message}"`,
        severity: r.escalation_level || 'high',
        source: 'whatsapp_support',
        customer_id: r.customer_id,
      }),
    },
  ],

  'S-02': [
    {
      triggers: 'S-04',
      label: 'Low RAG confidence → CEO escalation',
      condition: (r) => (r.confidence || 1) < 0.4,
      payload: (r, p) => ({
        incident: `Unanswered support query: "${p.query}"`,
        severity: 'medium',
        source: 'rag_brain',
        context: r.answer,
      }),
    },
  ],

  'S-03': [
    {
      triggers: 'S-04',
      label: 'Critical review alert → CEO notification',
      condition: (r) => r.urgency === 'critical' || (r.sentiment_score || 0) < -0.6,
      payload: (r) => ({
        incident: `Critical review received: "${(r.review_text || '').slice(0, 200)}"`,
        severity: 'critical',
        source: 'review_alert',
        rating: r.rating,
      }),
    },
    {
      triggers: 'SC-04',
      label: 'Product mentioned in review → refresh SEO meta',
      condition: (r) => !!r.product_id,
      payload: (r) => ({
        id: r.product_id,
        title: r.product_title || 'Product',
        body_html: r.review_text || '',
        trigger_reason: 'review_mention',
      }),
    },
  ],

  // ── SCALE ────────────────────────────────────────
  'SC-03': [
    {
      triggers: 'A-01',
      label: 'High-intent signal → create scored lead record',
      condition: (r) => r.qualification === 'high',
      payload: (r, p) => ({
        name: p.name || 'Sales Signal Lead',
        email: p.email,
        source: 'sales_signal',
        phone: p.phone || null,
        notes: `Intent signal: ${p.signal || p.message || ''}`,
      }),
    },
  ],

  'SC-04': [
    {
      triggers: 'A-04',
      label: 'New product SEO meta → generate supporting content',
      condition: () => true,
      payload: (r, p) => ({
        keyword: r.meta_title || p.title,
        product_id: p.id,
        context: `Product: ${p.title}. ${(p.body_html || '').replace(/<[^>]*>/g, '').slice(0, 300)}`,
      }),
    },
  ],
};

// ── Orchestrate ──────────────────────────────────────

async function orchestrate(tenantId, tenantConfig, workflowId, result, inputPayload, depth) {
  depth = depth || 0;
  if (depth > 3) return; // Guard against infinite cascade loops

  const cascades = CASCADE_MAP[workflowId];
  if (!cascades || cascades.length === 0) return;

  const handlers = _getHandlers();

  for (const cascade of cascades) {
    try {
      if (!cascade.condition(result || {}, inputPayload || {})) continue;

      const downstreamId = cascade.triggers;
      const handler = handlers[downstreamId];
      if (!handler) {
        console.warn(`[Orchestrator] No handler registered for downstream workflow: ${downstreamId}`);
        continue;
      }

      const downstreamPayload = cascade.payload(result || {}, inputPayload || {}, tenantConfig);

      emitEvent(tenantId, {
        type: 'cascade_start',
        from: workflowId,
        to: downstreamId,
        label: cascade.label,
        ts: new Date().toISOString(),
      });

      const downstreamResult = await handler(tenantId, downstreamPayload, tenantConfig);

      emitEvent(tenantId, {
        type: 'cascade_complete',
        from: workflowId,
        to: downstreamId,
        label: cascade.label,
        result: downstreamResult,
        ts: new Date().toISOString(),
      });

      // Recurse for downstream cascades
      await orchestrate(tenantId, tenantConfig, downstreamId, downstreamResult, downstreamPayload, depth + 1);

    } catch (err) {
      emitEvent(tenantId, {
        type: 'cascade_error',
        from: workflowId,
        to: cascade.triggers,
        label: cascade.label,
        error: err.message,
        ts: new Date().toISOString(),
      });
      console.error(`[Orchestrator] Cascade ${workflowId} → ${cascade.triggers} failed: ${err.message}`);
    }
  }
}

// ── SSE Helpers ──────────────────────────────────────

function emitEvent(tenantId, event) {
  orchestratorEvents.emit(`tenant:${tenantId}`, event);
  orchestratorEvents.emit('all', { tenantId, ...event });
}

function emitWorkflowRun(tenantId, workflowId, status, result) {
  emitEvent(tenantId, {
    type: 'workflow_run',
    workflow_id: workflowId,
    status,
    result: result || null,
    ts: new Date().toISOString(),
  });
}

// ── Handler Registry ─────────────────────────────────
// Lazy-loaded to avoid circular dependency issues at require() time

function _getHandlers() {
  return {
    'A-01': require('../workflows/acquire/a01-lead-capture').handleLeadCapture,
    'A-02': require('../workflows/acquire/a02-cold-email').handleColdEmail,
    'A-03': require('../workflows/acquire/a03-ig-dm').handleIgDm,
    'A-04': require('../workflows/acquire/a04-seo-content').handleSeoContent,
    'C-01': require('../workflows/convert/c01-cart-recovery').handleCartAbandoned,
    'C-02': require('../workflows/convert/c02-inventory-drop').handleInventoryUpdate,
    'C-03': require('../workflows/convert/c03-amazon-pdp').handleAmazonPdp,
    'C-04': require('../workflows/convert/c04-gamified-checkout').handleGamifiedCheckout,
    'I-01': require('../workflows/intelligence/i01-competitor-tracker').handleCompetitorTrack,
    'I-02': require('../workflows/intelligence/i02-revenue-reports').handleRevenueReport,
    'I-03': require('../workflows/intelligence/i03-customer-intel').handleCustomerIntel,
    'I-04': require('../workflows/intelligence/i04-tax-compliance').handleTaxReport,
    'R-01': require('../workflows/retain/r01-crm-followup').handleOrderCreated,
    'R-02': require('../workflows/retain/r02-loyalty-engine').handleLoyaltyEvent,
    'R-03': require('../workflows/retain/r03-social-auto').handleSocialPost,
    'R-04': require('../workflows/retain/r04-winback').handleWinback,
    'S-01': require('../workflows/support/s01-whatsapp-support').handleWhatsAppSupport,
    'S-02': require('../workflows/support/s02-rag-brain').handleRagQuery,
    'S-03': require('../workflows/support/s03-review-alerts').handleReviewAlert,
    'S-04': require('../workflows/support/s04-ceo-assistant').handleCeoAlert,
    'SC-01': require('../workflows/scale/sc01-ugc-collector').handleUgcCollect,
    'SC-02': require('../workflows/scale/sc02-funnel-analytics').handleFunnelAnalytics,
    'SC-03': require('../workflows/scale/sc03-sales-auto').handleSalesSignal,
    'SC-04': require('../workflows/scale/sc04-seo-meta').handleProductCreated,
  };
}

// ── Exports ──────────────────────────────────────────
module.exports = {
  orchestrate,
  emitEvent,
  emitWorkflowRun,
  orchestratorEvents,
  CASCADE_MAP,
  getHandlers: _getHandlers,
};
