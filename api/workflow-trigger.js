'use strict';

// ── Workflow Trigger Registry ────────────────────────
// Maps every workflow ID to its handler function and
// provides a default sample payload for manual triggering from the UI.
//
// Used by: POST /api/tenants/:slug/workflows/:id/trigger

const { orchestrate, emitWorkflowRun } = require('./orchestrator');
const { createClient } = require('@supabase/supabase-js');

// ── Default sample payloads per workflow ─────────────
// These are shown in the UI trigger form and used as the base when
// the user submits a manual trigger without filling every field.

const DEFAULT_PAYLOADS = {
  'A-01': {
    name: 'Alex Johnson',
    email: 'alex@example.com',
    source: 'website_form',
    phone: '+1-555-0100',
    notes: 'Interested in skincare bundle',
  },
  'A-02': {
    mode: 'run_batch',   // triggers the daily outreach batch
    limit: 10,
  },
  'A-03': {
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'instagram',
          sender: { id: '123456789' },
          recipient: { id: '987654321' },
          timestamp: String(Math.floor(Date.now() / 1000)),
          message: { mid: 'mid.test', text: 'Hi, do you ship internationally?' },
        },
      }],
    }],
  },
  'A-04': {
    keyword: 'best moisturizer for dry skin',
    product_id: null,
    context: '',
  },
  'C-01': {
    id: 'CART-' + Date.now(),
    token: 'sample-token',
    customer: { id: '1001', email: 'test@example.com', first_name: 'Sam' },
    line_items: [{ title: 'Hydrating Serum', price: '49.99', quantity: 1 }],
    total_price: '49.99',
    abandoned_checkout_url: 'https://store.example.com/checkout/recover',
  },
  'C-02': {
    id: 'PRODUCT-' + Date.now(),
    title: 'Vitamin C Brightening Serum',
    variants: [{ id: 'V001', inventory_quantity: 50, old_inventory_quantity: 0 }],
    product_type: 'Serum',
  },
  'C-03': {
    mode: 'run_weekly',  // triggers the Amazon PDP optimisation batch
    limit: 5,
  },
  'C-04': {
    token: 'CHECKOUT-' + Date.now(),
    customer: { id: '1002', email: 'gamer@example.com', first_name: 'Jamie' },
    line_items: [{ title: 'Eye Cream', price: '39.00', quantity: 2 }],
    total_price: '78.00',
    subtotal_price: '78.00',
  },
  'I-01': {
    mode: 'run_daily',   // triggers competitor scrape batch
  },
  'I-02': {
    mode: 'run_daily',   // triggers revenue analytics batch
    date: new Date().toISOString().split('T')[0],
  },
  'I-03': {
    event_type: 'page_view',
    customer_id: 'CUST-1001',
    email: 'loyal@example.com',
    metadata: { page: '/products/serum', time_on_page: 120 },
  },
  'I-04': {
    mode: 'run_monthly',
    month: new Date().toISOString().slice(0, 7),
  },
  'R-01': {
    id: 'ORDER-' + Date.now(),
    order_number: 1042,
    customer: { id: '2001', email: 'newbuyer@example.com', first_name: 'Morgan', orders_count: 1, total_spent: '89.00' },
    email: 'newbuyer@example.com',
    line_items: [{ title: 'Glow Kit Bundle' }],
    total_price: '89.00',
    created_at: new Date().toISOString(),
  },
  'R-02': {
    event_type: 'purchase',
    customer_id: 'CUST-2001',
    email: 'loyalmember@example.com',
    value: 89.0,
  },
  'R-03': {
    mode: 'run_schedule',  // posts next scheduled content
  },
  'R-04': {
    mode: 'run_daily',     // finds at-risk customers and sends winback
  },
  'S-01': {
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          contacts: [{ profile: { name: 'Riley' }, wa_id: '15550001234' }],
          messages: [{
            from: '15550001234',
            id: 'wamid.test',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'Where is my order?' },
            type: 'text',
          }],
        },
      }],
    }],
  },
  'S-02': {
    query: 'What is your return policy?',
    customer_id: 'CUST-3001',
  },
  'S-03': {
    mode: 'run_check',  // runs the review monitoring check
  },
  'S-04': {
    incident: 'Payment gateway returning 503 errors — checkout blocked',
    severity: 'high',
    source: 'manual_trigger',
  },
  'SC-01': {
    mode: 'run_check',  // runs the UGC collection check
  },
  'SC-02': {
    mode: 'run_daily',  // runs full funnel analytics report
  },
  'SC-03': {
    intent: 'high',
    name: 'Casey Smith',
    email: 'prospect@example.com',
    source: 'website',
    signal: 'Viewed pricing page 3 times in 24h',
  },
  'SC-04': {
    id: 'PROD-' + Date.now(),
    title: 'Night Repair Cream',
    body_html: '<p>Deep overnight repair formula with retinol and peptides.</p>',
    product_type: 'Moisturizer',
    tags: 'retinol, anti-aging, night cream',
    vendor: 'Lumino Skin',
  },
};

// ── Trigger a workflow by ID ─────────────────────────

async function triggerWorkflow(tenantId, tenantConfig, workflowId, userPayload) {
  const handlers = _getHandlers();
  const handler = handlers[workflowId];

  if (!handler) {
    throw new Error(`No handler registered for workflow: ${workflowId}`);
  }

  // Merge user-supplied overrides on top of the default payload
  const defaults = DEFAULT_PAYLOADS[workflowId] || {};
  const payload = Object.assign({}, defaults, userPayload || {});

  // Mark run start in workflow_states
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const runStart = new Date().toISOString();
  await sb.from('workflow_states').upsert(
    { tenant_id: tenantId, workflow_id: workflowId, last_run_at: runStart, updated_at: runStart },
    { onConflict: 'tenant_id,workflow_id' }
  );

  emitWorkflowRun(tenantId, workflowId, 'running', null);

  let result;
  try {
    result = await handler(tenantId, payload, tenantConfig);

    // Increment run_count on success
    await sb.rpc('increment_workflow_run', { p_tenant_id: tenantId, p_workflow_id: workflowId })
      .catch(() => {}); // rpc may not exist; gracefully ignore

    emitWorkflowRun(tenantId, workflowId, 'completed', result);

    // Fire cascades (non-blocking — do not await if you want fire-and-forget)
    orchestrate(tenantId, tenantConfig, workflowId, result, payload).catch((err) => {
      console.error(`[Trigger] Post-run cascade error for ${workflowId}:`, err.message);
    });

  } catch (err) {
    // Increment error_count
    await sb.rpc('increment_workflow_error', { p_tenant_id: tenantId, p_workflow_id: workflowId })
      .catch(() => {});

    emitWorkflowRun(tenantId, workflowId, 'error', { error: err.message });
    throw err;
  }

  return result;
}

// ── Same lazy handler loader used by orchestrator ────

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

module.exports = { triggerWorkflow, DEFAULT_PAYLOADS };
