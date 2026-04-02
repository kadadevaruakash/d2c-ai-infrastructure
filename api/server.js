'use strict';

const path = require('path');
const express = require('express');
const { handleOnboard }       = require('./onboarding');
const { handleHealth, handleTenantHealth } = require('./health');
const { createClient }        = require('@supabase/supabase-js');
const { initScheduler }       = require('../scheduler');
const { orchestrate, orchestratorEvents, emitWorkflowRun } = require('./orchestrator');
const { triggerWorkflow, DEFAULT_PAYLOADS } = require('./workflow-trigger');
const { billingRouter }          = require('./billing');
const { shopifyOauthRouter }     = require('./shopify-oauth');
const { clientPortalRouter }     = require('./client-portal');
const { agencyRouter }           = require('./agency');
const { brevoWebhookRouter, getEmailStats } = require('./brevo-webhooks');
const { abTestingRouter }        = require('./ab-testing');
const { contentCalendarRouter }  = require('./content-calendar');
const { ragManagerRouter }       = require('./rag-manager');
const { reportsRouter }          = require('./reports');
const { logExecution }           = require('./execution-logger');
const { handleWhatsAppReply }    = require('./whatsapp-reply-router');
const { beforeWorkflow, afterWorkflow } = require('./usage-meter');

// Webhook handlers
const { handleLeadCapture }       = require('../workflows/acquire/a01-lead-capture');
const { handleIgDm }              = require('../workflows/acquire/a03-ig-dm');
const { handleCartAbandoned }     = require('../workflows/convert/c01-cart-recovery');
const { handleInventoryUpdate }   = require('../workflows/convert/c02-inventory-drop');
const { handleGamifiedCheckout }  = require('../workflows/convert/c04-gamified-checkout');
const { handleCustomerIntel }     = require('../workflows/intelligence/i03-customer-intel');
const { handleOrderCreated }      = require('../workflows/retain/r01-crm-followup');
const { handleLoyaltyEvent }      = require('../workflows/retain/r02-loyalty-engine');
const { handleWhatsAppSupport }   = require('../workflows/support/s01-whatsapp-support');
const { handleRagQuery }          = require('../workflows/support/s02-rag-brain');
const { handleCeoAlert }          = require('../workflows/support/s04-ceo-assistant');
const { handleSalesSignal }       = require('../workflows/scale/sc03-sales-auto');
const { handleProductCreated }    = require('../workflows/scale/sc04-seo-meta');

const app = express();

// Raw body for Stripe webhook signature verification — must come before express.json()
app.use('/api/billing/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Helpers ──────────────────────────────────

function requireApiKey(req, res, next) {
  // Accept key via header (normal API calls) or query param (SSE / EventSource)
  const key = req.headers['x-api-key'] || req.query['x-api-key'];
  if (key !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function getTenantConfig(slug) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await sb
    .from('tenant_config')
    .select('*, tenants!inner(id, slug, name, plan, status)')
    .eq('tenants.slug', slug)
    .single();
  if (error || !data) return null;
  return { ...data, tenant_id: data.tenants.id };
}

// ── Health ───────────────────────────────────
app.get('/api/health', handleHealth);
app.get('/api/health/:tenantSlug', requireApiKey, handleTenantHealth);

// ── Onboarding ───────────────────────────────
app.post('/api/onboard', requireApiKey, handleOnboard);

// ── Config ───────────────────────────────────
app.get('/api/config/:tenantSlug', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.tenantSlug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  res.json(config);
});

// ── Centralized Notification ─────────────────
app.post('/api/notify', requireApiKey, async (req, res) => {
  const { tenantSlug, channelKey, message, level = 'info', emailOpts } = req.body;
  const config = await getTenantConfig(tenantSlug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const notifier = require('../shared/notification');
  await notifier.notify(config, channelKey, message, level, emailOpts);
  res.json({ sent: true });
});

// ── Webhook Router ───────────────────────────
// Generic handler: resolves tenant, calls handler fn, fires cascades, returns JSON
async function webhookHandler(req, res, handlerFn, workflowId) {
  const { tenantSlug } = req.params;
  try {
    const config = await getTenantConfig(tenantSlug);
    if (!config) return res.status(404).json({ error: 'Tenant not found' });

    // ── Credit gate ──────────────────────────────────────────
    if (workflowId) {
      const credit = await beforeWorkflow(config.tenant_id, workflowId);
      if (!credit.allowed) {
        return res.status(402).json({
          error:          'Insufficient credits',
          reason:         credit.reason,
          balance:        credit.balance_before,
          cost_credits:   credit.cost_credits,
          recharge_url:   `/billing?topup=1`,
        });
      }
    }

    if (workflowId) emitWorkflowRun(config.tenant_id, workflowId, 'running', null);

    let result;
    let success = false;
    try {
      result  = await handlerFn(config.tenant_id, req.body, config);
      success = true;
    } finally {
      if (workflowId) await afterWorkflow(config.tenant_id, workflowId, success);
    }

    if (workflowId) emitWorkflowRun(config.tenant_id, workflowId, 'completed', result);

    // Fire cascades asynchronously — don't block webhook response
    if (workflowId) {
      orchestrate(config.tenant_id, config, workflowId, result, req.body).catch((err) => {
        console.error(`[Orchestrator] Cascade error for ${workflowId}:`, err.message);
      });
    }

    res.json(result);
  } catch (err) {
    console.error(`[${req.path}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Acquire ──────────────────────────────────
app.post('/webhook/:tenantSlug/lead-capture',    (req, res) => webhookHandler(req, res, handleLeadCapture, 'A-01'));
app.post('/webhook/:tenantSlug/ig-dm',           (req, res) => webhookHandler(req, res, handleIgDm, 'A-03'));

// Meta webhook verification for Instagram DMs
app.get('/webhook/:tenantSlug/ig-dm', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// ── Convert ──────────────────────────────────
app.post('/webhook/:tenantSlug/shopify/cart-abandoned',   (req, res) => webhookHandler(req, res, handleCartAbandoned, 'C-01'));
app.post('/webhook/:tenantSlug/shopify/inventory-update', (req, res) => webhookHandler(req, res, handleInventoryUpdate, 'C-02'));
app.post('/webhook/:tenantSlug/shopify/checkout-started', (req, res) => webhookHandler(req, res, handleGamifiedCheckout, 'C-04'));

// ── Intelligence ─────────────────────────────
app.post('/webhook/:tenantSlug/customer-intel', (req, res) => webhookHandler(req, res, handleCustomerIntel, 'I-03'));

// ── Retain ───────────────────────────────────
app.post('/webhook/:tenantSlug/shopify/order-created', (req, res) => webhookHandler(req, res, handleOrderCreated, 'R-01'));
app.post('/webhook/:tenantSlug/loyalty-event',         (req, res) => webhookHandler(req, res, handleLoyaltyEvent, 'R-02'));

// ── Support ──────────────────────────────────
app.post('/webhook/:tenantSlug/whatsapp-support', (req, res) => webhookHandler(req, res, handleWhatsAppSupport, 'S-01'));
app.post('/webhook/:tenantSlug/rag-query',         (req, res) => webhookHandler(req, res, handleRagQuery, 'S-02'));
app.post('/webhook/:tenantSlug/ceo-alert',         (req, res) => webhookHandler(req, res, handleCeoAlert, 'S-04'));

// Meta webhook verification for WhatsApp (support + reply)
app.get('/webhook/:tenantSlug/whatsapp-support', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// ── WhatsApp Reply Router ─────────────────────────────
// All inbound WA messages from ops staff (reps, managers) come here.
// The reply router resolves the pending action and dispatches accordingly.
// This is ONE Meta webhook subscription — all phone numbers in the
// Business Account send to the same webhook URL.
app.post('/webhook/:tenantSlug/whatsapp-reply', async (req, res) => {
  const { tenantSlug } = req.params;
  try {
    const config = await getTenantConfig(tenantSlug);
    if (!config) return res.status(404).json({ error: 'Tenant not found' });
    await handleWhatsAppReply(req, res, config.tenant_id, config);
  } catch (err) {
    console.error('[whatsapp-reply] Error:', err.message);
    // Still send 200 to Meta to prevent retries for unrecoverable errors
    if (!res.headersSent) res.json({ received: true });
  }
});

// Meta webhook verification for WhatsApp reply
app.get('/webhook/:tenantSlug/whatsapp-reply', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// ── Cold Lead Scan (Scenario 5 — manual trigger) ─────
app.post('/webhook/:tenantSlug/cold-lead-scan', requireApiKey, async (req, res) => {
  const { tenantSlug } = req.params;
  try {
    const config = await getTenantConfig(tenantSlug);
    if (!config) return res.status(404).json({ error: 'Tenant not found' });
    const { handleColdLeadScan } = require('../workflows/intelligence/i03-customer-intel');
    const result = await handleColdLeadScan(config.tenant_id, req.body || {}, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cold Email Batch (Scenario 2 — manual trigger) ───
app.post('/webhook/:tenantSlug/cold-email-batch', requireApiKey, async (req, res) => {
  const { tenantSlug } = req.params;
  try {
    const config = await getTenantConfig(tenantSlug);
    if (!config) return res.status(404).json({ error: 'Tenant not found' });
    const { handleColdEmailBatch } = require('../workflows/acquire/a02-cold-email');
    const result = await handleColdEmailBatch(config.tenant_id, req.body || {}, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scale ────────────────────────────────────
app.post('/webhook/:tenantSlug/sales-signal',           (req, res) => webhookHandler(req, res, handleSalesSignal, 'SC-03'));
app.post('/webhook/:tenantSlug/shopify/product-created', (req, res) => webhookHandler(req, res, handleProductCreated, 'SC-04'));

// ── Frontend Management APIs ─────────────────

// GET /api/tenants/:slug/workflows
// Returns all 24 workflow states for a tenant
app.get('/api/tenants/:slug/workflows', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await sb
    .from('workflow_states')
    .select('*')
    .eq('tenant_id', config.tenant_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /api/tenants/:slug/workflows/:workflowId
// Toggle a workflow on/off and/or update config_overrides
app.patch('/api/tenants/:slug/workflows/:workflowId', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const { is_active, config_overrides } = req.body;
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const update = { updated_at: new Date().toISOString() };
  if (typeof is_active === 'boolean') update.is_active = is_active;
  if (config_overrides !== undefined) update.config_overrides = config_overrides;
  const { data, error } = await sb
    .from('workflow_states')
    .upsert({ tenant_id: config.tenant_id, workflow_id: req.params.workflowId, ...update },
             { onConflict: 'tenant_id,workflow_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/tenants/:slug/analytics
// Returns aggregated stats across all workflow tables
app.get('/api/tenants/:slug/analytics', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const tid = config.tenant_id;
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [leads, carts, tickets, loyalty, winback, workflows] = await Promise.all([
    sb.from('leads').select('score, category, created_at').eq('tenant_id', tid),
    sb.from('cart_recoveries').select('status, cart_value, recovery_value, created_at').eq('tenant_id', tid),
    sb.from('support_tickets').select('status, created_at').eq('tenant_id', tid),
    sb.from('loyalty_transactions').select('points, event_type, created_at').eq('tenant_id', tid),
    sb.from('winback_campaigns').select('converted, created_at').eq('tenant_id', tid),
    sb.from('workflow_states').select('workflow_id, run_count, error_count, last_run_at, is_active').eq('tenant_id', tid),
  ]);
  res.json({
    leads:     leads.data     || [],
    carts:     carts.data     || [],
    tickets:   tickets.data   || [],
    loyalty:   loyalty.data   || [],
    winback:   winback.data   || [],
    workflows: workflows.data || [],
  });
});

// GET /api/tenants/:slug/integrations
// Returns health status for all configured integrations
app.get('/api/tenants/:slug/integrations', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const checks = [
    { key: 'openai',     label: 'OpenAI',          env: 'OPENAI_API_KEY',           workflows: ['A-01','A-02','A-03','A-04','C-01','C-02','C-03','C-04','I-01','I-02','I-03','R-01','R-02','R-04','S-01','S-02','S-03','S-04','SC-01','SC-02','SC-03','SC-04'] },
    { key: 'supabase',   label: 'Supabase',         env: 'SUPABASE_URL',             workflows: ['all 24'] },
    { key: 'shopify',    label: 'Shopify',          env: 'SHOPIFY_ACCESS_TOKEN',     workflows: ['C-01','C-02','C-04','I-02','I-04','R-01','SC-02','SC-04'] },
    { key: 'brevo',      label: 'Brevo (Email)',    env: 'BREVO_API_KEY',            workflows: ['A-02','C-01','C-02','R-01','R-02','R-04','SC-03'] },
    { key: 'slack',      label: 'Slack',            env: 'SLACK_BOT_TOKEN',          workflows: ['all 24'] },
    { key: 'whatsapp',   label: 'WhatsApp',         env: 'WHATSAPP_ACCESS_TOKEN',    workflows: ['A-03','R-02','S-01','S-04'] },
    { key: 'instagram',  label: 'Instagram',        env: 'INSTAGRAM_ACCESS_TOKEN',   workflows: ['A-03','R-03','SC-01'] },
    { key: 'pinecone',   label: 'Pinecone (RAG)',   env: 'PINECONE_API_KEY',         workflows: ['S-02'] },
    { key: 'google',     label: 'Google',           env: 'GOOGLE_SERVICE_ACCOUNT',   workflows: ['I-02','I-04','SC-02'] },
  ];
  const result = checks.map(({ key, label, env, workflows }) => ({
    key, label, workflows,
    connected: !!process.env[env],
    env_var: env,
  }));
  res.json(result);
});

// PUT /api/tenants/:slug/config
// Update tenant_config fields from the frontend settings page
app.put('/api/tenants/:slug/config', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  // Whitelist updatable fields (never allow tenant_id, id to be overwritten)
  const ALLOWED = [
    'brand_name','brand_voice','store_url','calendly_url','logo_url','primary_color',
    'strategy_email','ops_email','finance_email','support_email','manager_email','ceo_phone',
    'slack_channel_leads','slack_channel_outreach','slack_channel_hot_leads','slack_channel_content',
    'slack_channel_amazon','slack_channel_launches','slack_channel_analytics','slack_channel_revenue',
    'slack_channel_crm','slack_channel_retention','slack_channel_support','slack_channel_reviews',
    'slack_channel_social','slack_channel_ugc','slack_channel_incidents','slack_channel_seo',
    'slack_channel_sales','slack_channel_checkout',
    'free_shipping_threshold','default_currency','ai_model_standard','ai_model_premium',
    'lead_hot_score_threshold','cart_recovery_delay_1h','cart_recovery_delay_4h','cart_recovery_delay_24h',
    'winback_stage2_days','winback_stage3_days','churn_risk_threshold',
    'roas_alert_threshold','margin_alert_threshold','revenue_drop_threshold',
    'feature_amazon','feature_loyalty','feature_ugc','feature_gamification','feature_rag','feature_tax_reports',
  ];
  const updates = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await sb
    .from('tenant_config')
    .update(updates)
    .eq('tenant_id', config.tenant_id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Manual Workflow Trigger ───────────────────
// POST /api/tenants/:slug/workflows/:id/trigger
// Manually execute any workflow from the UI with an optional payload override
app.post('/api/tenants/:slug/workflows/:id/trigger', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });

  try {
    const result = await triggerWorkflow(
      config.tenant_id,
      config,
      req.params.id,
      req.body.payload || {}
    );
    res.json({ success: true, workflow_id: req.params.id, result });
  } catch (err) {
    console.error(`[Trigger] ${req.params.id} failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenants/:slug/workflows/:id/default-payload
// Returns the default sample payload for the trigger form
app.get('/api/tenants/:slug/workflows/:id/default-payload', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const payload = DEFAULT_PAYLOADS[req.params.id] || {};
  res.json(payload);
});

// GET /api/tenants/:slug/cascades
// Returns the full cascade dependency map (for frontend visualisation)
app.get('/api/tenants/:slug/cascades', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const { CASCADE_MAP } = require('./orchestrator');
  // Serialize: strip condition/payload functions, keep labels
  const serialized = {};
  for (const [wfId, cascades] of Object.entries(CASCADE_MAP)) {
    serialized[wfId] = cascades.map(c => ({ triggers: c.triggers, label: c.label }));
  }
  res.json(serialized);
});

// ── Orchestrator SSE Stream ───────────────────
// GET /api/tenants/:slug/events
// Streams real-time cascade + workflow run events to the frontend
app.get('/api/tenants/:slug/events', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const tenantId = config.tenant_id;
  const channel  = `tenant:${tenantId}`;

  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) {}
  };

  // Send a heartbeat every 25s to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 25000);

  orchestratorEvents.on(channel, send);

  req.on('close', () => {
    clearInterval(heartbeat);
    orchestratorEvents.off(channel, send);
  });
});

// ── Execution Logs ───────────────────────────
app.get('/api/tenants/:slug/logs', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  let q = sb.from('workflow_execution_logs').select('*').eq('tenant_id', config.tenant_id).order('executed_at', { ascending: false }).limit(limit);
  if (req.query.workflow_id) q = q.eq('workflow_id', req.query.workflow_id);
  if (req.query.status)      q = q.eq('status', req.query.status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Revenue Attribution ───────────────────────
app.get('/api/tenants/:slug/revenue-attribution', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await sb.from('revenue_attribution').select('workflow_id, revenue, attributed_at').eq('tenant_id', config.tenant_id).gte('attributed_at', since).order('attributed_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  // Aggregate by workflow
  const map = {};
  for (const row of (data || [])) {
    map[row.workflow_id] = map[row.workflow_id] || { workflow_id: row.workflow_id, total: 0, count: 0 };
    map[row.workflow_id].total += row.revenue || 0;
    map[row.workflow_id].count++;
  }
  res.json(Object.values(map).sort((a, b) => b.total - a.total));
});

// ── Cohort Retention ─────────────────────────
app.get('/api/tenants/:slug/cohorts', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  // Fetch loyalty transactions as proxy for repeat purchase retention
  const { data } = await sb.from('loyalty_transactions').select('customer_id, created_at').eq('tenant_id', config.tenant_id).order('created_at', { ascending: true });
  const rows = data || [];
  // Build 6 monthly cohorts × 6 months retention
  const cohorts = [];
  const now = new Date();
  for (let c = 5; c >= 0; c--) {
    const cohortDate = new Date(now.getFullYear(), now.getMonth() - c, 1);
    const cohortKey = cohortDate.toISOString().slice(0, 7);
    const cohortCustomers = new Set(rows.filter(r => r.created_at?.slice(0, 7) === cohortKey).map(r => r.customer_id));
    const size = cohortCustomers.size;
    const retention = [];
    for (let m = 0; m <= 5 - c; m++) {
      const mDate = new Date(cohortDate.getFullYear(), cohortDate.getMonth() + m + 1, 1);
      const mKey = mDate.toISOString().slice(0, 7);
      const active = new Set(rows.filter(r => r.created_at?.slice(0, 7) === mKey && cohortCustomers.has(r.customer_id))).size;
      retention.push(size > 0 ? Math.round((active / size) * 100) : null);
    }
    cohorts.push({ cohort: cohortKey, size, retention });
  }
  res.json(cohorts);
});

// ── Email Stats ───────────────────────────────
app.get('/api/tenants/:slug/email-stats', requireApiKey, async (req, res) => {
  const config = await getTenantConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  res.json(await getEmailStats(config.tenant_id));
});

// ── New Feature Routers ───────────────────────
app.use('/api/billing',  billingRouter);
app.use('/api/shopify',  shopifyOauthRouter);
app.use('/api',          clientPortalRouter);
app.use('/api/agency',   agencyRouter);
app.use('/api/webhook',  brevoWebhookRouter);
app.use('/api',          requireApiKey, abTestingRouter);
app.use('/api',          requireApiKey, contentCalendarRouter);
app.use('/api',          requireApiKey, ragManagerRouter);
app.use('/api',          requireApiKey, reportsRouter);

// ── Start ────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] D2C AI Infrastructure running on port ${PORT}`);

  const { validateCredentials } = require('../config/credentials.config');
  const { valid, missing } = validateCredentials();
  if (!valid) {
    console.warn('[server] WARNING: Missing credentials:', missing.join(', '));
  } else {
    console.log('[server] All credentials present');
  }

  initScheduler();
});

module.exports = app;
