'use strict';

/**
 * D2C AI Infrastructure — Billing API
 *
 * PAYG model: tenants pay a $29/mo base fee (infrastructure) + credits on demand.
 * Credits are purchased in bundles via Stripe PaymentIntents (one-time charges).
 * Auto-topup uses Stripe off-session charging against a saved payment method.
 *
 * Routes:
 *   GET  /api/billing/plans                   — return CREDIT_BUNDLES for the UI
 *   GET  /api/billing/balance/:slug           — current balance + settings
 *   GET  /api/billing/usage/:slug             — per-workflow usage for current month
 *   GET  /api/billing/transactions/:slug      — last 25 credit transactions
 *   POST /api/billing/purchase-credits        — create Stripe PaymentIntent for bundle
 *   POST /api/billing/base-fee-subscribe      — create Stripe Checkout for $29/mo base fee
 *   POST /api/billing/portal-session          — Stripe billing portal (manage base fee sub)
 *   PUT  /api/billing/settings/:slug          — update spend cap, auto-topup, payment method
 *   POST /api/webhook/stripe                  — Stripe webhook (raw body required)
 */

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const {
  CREDIT_BUNDLES,
  BASE_FEE_USD,
  addCredits,
  getBalance,
  getMonthlyUsage,
  getTransactionHistory,
  updateBillingSettings,
} = require('../shared/credits');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function resolveTenant(slug) {
  const { data } = await sb()
    .from('tenants')
    .select('id, slug, name')
    .eq('slug', slug)
    .single()
    .catch(() => ({ data: null }));
  return data;
}

async function getCreditAccount(tenantId) {
  const { data } = await sb()
    .from('credit_accounts')
    .select('stripe_customer_id, stripe_payment_method_id, base_fee_subscription_id')
    .eq('tenant_id', tenantId)
    .single()
    .catch(() => ({ data: null }));
  return data;
}

// ─────────────────────────────────────────────────────────────
// GET /api/billing/plans
// Returns the full bundle catalogue for display in the UI.
// ─────────────────────────────────────────────────────────────

router.get('/plans', (_req, res) => {
  res.json({
    base_fee_usd: BASE_FEE_USD,
    bundles: Object.values(CREDIT_BUNDLES),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/balance/:slug
// ─────────────────────────────────────────────────────────────

router.get('/balance/:slug', async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const balance = await getBalance(tenant.id);
  res.json(balance);
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/usage/:slug
// Per-workflow usage breakdown for the current calendar month.
// ─────────────────────────────────────────────────────────────

router.get('/usage/:slug', async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const month = req.query.month || null; // optional YYYY-MM override
  const usage = await getMonthlyUsage(tenant.id, month);
  res.json({ month: month || new Date().toISOString().slice(0, 7), usage });
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/transactions/:slug
// ─────────────────────────────────────────────────────────────

router.get('/transactions/:slug', async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const txns  = await getTransactionHistory(tenant.id, limit);
  res.json({ transactions: txns });
});

// ─────────────────────────────────────────────────────────────
// POST /api/billing/purchase-credits
// Creates a Stripe PaymentIntent for a credit bundle.
// The client confirms it (Stripe.js), then the webhook fires.
// ─────────────────────────────────────────────────────────────

router.post('/purchase-credits', async (req, res) => {
  const { tenant_slug, bundle_id, save_payment_method } = req.body;
  if (!tenant_slug || !bundle_id) {
    return res.status(400).json({ error: 'tenant_slug and bundle_id required' });
  }

  const bundle = CREDIT_BUNDLES[bundle_id];
  if (!bundle) {
    return res.status(400).json({ error: `Unknown bundle: ${bundle_id}. Valid: ${Object.keys(CREDIT_BUNDLES).join(', ')}` });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });
  }

  const tenant = await resolveTenant(tenant_slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const account = await getCreditAccount(tenant.id);

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Ensure Stripe customer exists
    let stripeCustomerId = account?.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { tenant_id: tenant.id, tenant_slug: tenant.slug },
        name: tenant.name,
      });
      stripeCustomerId = customer.id;
      await sb()
        .from('credit_accounts')
        .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenant.id);
    }

    // Create a pending purchase record
    const { data: purchase } = await sb()
      .from('credit_purchases')
      .insert({
        tenant_id:         tenant.id,
        bundle_id,
        credits_purchased: bundle.credits_base,
        credits_bonus:     bundle.credits_bonus,
        amount_usd:        bundle.price_usd,
        status:            'pending',
        is_auto_topup:     false,
        created_at:        new Date().toISOString(),
      })
      .select('id')
      .single();

    const intentParams = {
      amount:   Math.round(bundle.price_usd * 100),
      currency: 'usd',
      customer: stripeCustomerId,
      metadata: {
        tenant_id:   tenant.id,
        bundle_id,
        purchase_id: purchase?.id || '',
        credits:     String(bundle.credits_total),
      },
      description: `D2C AI — ${bundle.label} credit bundle (${bundle.credits_total.toLocaleString()} credits)`,
    };

    if (save_payment_method) {
      intentParams.setup_future_usage = 'off_session';
    }

    const intent = await stripe.paymentIntents.create(intentParams);

    res.json({
      client_secret:     intent.id,   // frontend passes this to stripe.confirmCardPayment
      payment_intent_id: intent.id,
      amount_usd:        bundle.price_usd,
      credits_total:     bundle.credits_total,
      bundle,
    });
  } catch (err) {
    console.error('[billing] purchase-credits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/billing/base-fee-subscribe
// Creates a Stripe Checkout Session for the $29/mo base fee.
// ─────────────────────────────────────────────────────────────

router.post('/base-fee-subscribe', async (req, res) => {
  const { tenant_slug, success_url, cancel_url } = req.body;
  if (!tenant_slug) return res.status(400).json({ error: 'tenant_slug required' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured.' });
  if (!process.env.STRIPE_PRICE_BASE_FEE) return res.status(503).json({ error: 'STRIPE_PRICE_BASE_FEE not set.' });

  const tenant = await resolveTenant(tenant_slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const account = await getCreditAccount(tenant.id);

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    let stripeCustomerId = account?.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { tenant_id: tenant.id, tenant_slug },
        name: tenant.name,
      });
      stripeCustomerId = customer.id;
      await sb()
        .from('credit_accounts')
        .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenant.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      customer:             stripeCustomerId,
      line_items: [{ price: process.env.STRIPE_PRICE_BASE_FEE, quantity: 1 }],
      success_url:          success_url || `${req.headers.origin}/?subscribed=true`,
      cancel_url:           cancel_url  || `${req.headers.origin}/`,
      metadata:             { tenant_id: tenant.id, tenant_slug, type: 'base_fee' },
    });

    res.json({ checkout_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/billing/portal-session
// Opens the Stripe billing portal so customers can manage
// their base fee subscription and payment methods.
// ─────────────────────────────────────────────────────────────

router.post('/portal-session', async (req, res) => {
  const { tenant_slug } = req.body;
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured.' });

  const tenant = await resolveTenant(tenant_slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const account = await getCreditAccount(tenant.id);
  if (!account?.stripe_customer_id) {
    return res.status(404).json({ error: 'No Stripe customer found. Purchase credits first.' });
  }

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer:   account.stripe_customer_id,
      return_url: req.body.return_url || `${req.headers.origin}/`,
    });
    res.json({ portal_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/billing/settings/:slug
// Update spend cap, auto-topup preferences, payment method.
// ─────────────────────────────────────────────────────────────

router.put('/settings/:slug', async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const result = await updateBillingSettings(tenant.id, req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/webhook/stripe
// Raw body required — must be mounted BEFORE express.json() in server.js.
// Handles:
//   payment_intent.succeeded       → add credits (bundle purchase or auto-topup)
//   checkout.session.completed     → activate base fee subscription
//   customer.subscription.updated  → sync base fee status
//   customer.subscription.deleted  → mark base fee inactive
//   payment_method.attached        → save payment method for auto-topup
// ─────────────────────────────────────────────────────────────

router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe not configured.' });
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[billing] Stripe webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ACK immediately
  res.json({ received: true });

  try {
    await _handleStripeEvent(event);
  } catch (err) {
    console.error('[billing] Stripe event handler error:', err.message, 'event:', event.type);
  }
});

// ─────────────────────────────────────────────────────────────
// Stripe event dispatcher
// ─────────────────────────────────────────────────────────────

async function _handleStripeEvent(event) {
  switch (event.type) {

    // ── Credit bundle purchase completed ─────────────────────
    case 'payment_intent.succeeded': {
      const intent = event.data.object;
      const { tenant_id, bundle_id, purchase_id, auto_topup } = intent.metadata || {};
      if (!tenant_id || !bundle_id) return;

      const bundle = CREDIT_BUNDLES[bundle_id];
      if (!bundle) {
        console.error('[billing] Unknown bundle in payment_intent:', bundle_id);
        return;
      }

      // Add credits
      await addCredits(
        tenant_id,
        bundle.credits_total,
        auto_topup === 'true' ? 'auto_topup' : 'purchase',
        intent.id,
        bundle_id
      );

      // Mark purchase as completed
      if (purchase_id) {
        await sb()
          .from('credit_purchases')
          .update({
            status:                  'completed',
            stripe_payment_intent_id: intent.id,
            stripe_charge_id:        intent.latest_charge || null,
            completed_at:            new Date().toISOString(),
          })
          .eq('id', purchase_id);
      }

      // If the payment method was saved, store it for auto-topup
      if (intent.payment_method && intent.setup_future_usage === 'off_session') {
        await sb()
          .from('credit_accounts')
          .update({
            stripe_payment_method_id: intent.payment_method,
            updated_at: new Date().toISOString(),
          })
          .eq('tenant_id', tenant_id);
      }

      console.log(`[billing] +${bundle.credits_total} credits → tenant ${tenant_id} (${bundle_id})`);
      break;
    }

    // ── Base fee subscription activated via Checkout ──────────
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.metadata?.type !== 'base_fee') return;

      const { tenant_id } = session.metadata;
      if (!tenant_id) return;

      await sb()
        .from('credit_accounts')
        .update({
          base_fee_active:          true,
          base_fee_subscription_id: session.subscription,
          stripe_customer_id:       session.customer,
          updated_at:               new Date().toISOString(),
        })
        .eq('tenant_id', tenant_id);

      console.log(`[billing] Base fee activated → tenant ${tenant_id}`);
      break;
    }

    // ── Base fee subscription changed ─────────────────────────
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const active = sub.status === 'active' || sub.status === 'trialing';

      await sb()
        .from('credit_accounts')
        .update({ base_fee_active: active, updated_at: new Date().toISOString() })
        .eq('base_fee_subscription_id', sub.id);
      break;
    }

    // ── Base fee subscription cancelled ───────────────────────
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await sb()
        .from('credit_accounts')
        .update({ base_fee_active: false, base_fee_subscription_id: null, updated_at: new Date().toISOString() })
        .eq('base_fee_subscription_id', sub.id);

      console.log(`[billing] Base fee cancelled for sub ${sub.id}`);
      break;
    }

    // ── Payment method attached to customer ───────────────────
    case 'payment_method.attached': {
      const pm = event.data.object;
      // Only store if this is the first payment method (customer just added card)
      if (!pm.customer) return;

      const { data: account } = await sb()
        .from('credit_accounts')
        .select('id, stripe_payment_method_id')
        .eq('stripe_customer_id', pm.customer)
        .single()
        .catch(() => ({ data: null }));

      if (account && !account.stripe_payment_method_id) {
        await sb()
          .from('credit_accounts')
          .update({ stripe_payment_method_id: pm.id, updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', pm.customer);
      }
      break;
    }

    default:
      break;
  }
}

module.exports = { billingRouter: router, CREDIT_BUNDLES };
