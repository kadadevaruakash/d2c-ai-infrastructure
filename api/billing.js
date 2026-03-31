'use strict';

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const PLANS = [
  {
    id: 'growth', name: 'Growth', price_monthly: 297,
    stripe_price_id: process.env.STRIPE_PRICE_GROWTH || 'price_growth',
    features: ['10 workflows', 'Up to 2,000 leads/mo', 'Cart recovery', 'WhatsApp support', 'Slack notifications'],
    limits: { workflows: 10, leads_per_month: 2000, team_seats: 2 },
  },
  {
    id: 'scale', name: 'Scale', price_monthly: 597,
    stripe_price_id: process.env.STRIPE_PRICE_SCALE || 'price_scale',
    features: ['All 24 workflows', 'Unlimited leads', 'Loyalty engine', 'A/B testing', 'Revenue attribution', 'Content calendar', 'Priority support'],
    limits: { workflows: 24, leads_per_month: -1, team_seats: 5 },
  },
  {
    id: 'enterprise', name: 'Enterprise', price_monthly: 1497,
    stripe_price_id: process.env.STRIPE_PRICE_ENTERPRISE || 'price_enterprise',
    features: ['Everything in Scale', 'Dedicated n8n instance', 'Separate Supabase DB', 'White-label dashboard', 'SLA guarantee', 'Dedicated account manager'],
    limits: { workflows: 24, leads_per_month: -1, team_seats: -1 },
  },
];

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

// GET /api/billing/plans
router.get('/plans', (_req, res) => res.json(PLANS));

// POST /api/billing/checkout-session
router.post('/checkout-session', async (req, res) => {
  const { tenant_slug, plan, success_url, cancel_url } = req.body;
  if (!tenant_slug || !plan) return res.status(400).json({ error: 'tenant_slug and plan required' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });

  const planDef = PLANS.find(p => p.id === plan);
  if (!planDef) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: planDef.stripe_price_id, quantity: 1 }],
      success_url: success_url || `${req.headers.origin}/?upgraded=true`,
      cancel_url:  cancel_url  || `${req.headers.origin}/`,
      metadata: { tenant_slug, plan },
    });
    res.json({ checkout_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/portal-session
router.post('/portal-session', async (req, res) => {
  const { tenant_slug } = req.body;
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured.' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const { data: tenant } = await sb().from('tenants').select('id').eq('slug', tenant_slug).single();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const { data: sub } = await sb().from('stripe_subscriptions').select('stripe_customer_id').eq('tenant_id', tenant.id).single();
    if (!sub?.stripe_customer_id) return res.status(404).json({ error: 'No Stripe customer found' });
    const session = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: `${req.headers.origin}/` });
    res.json({ portal_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhook/stripe — raw body required (mounted before express.json in server)
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe not configured.' });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { tenant_slug, plan } = session.metadata || {};
    if (tenant_slug && plan) {
      const { data: tenant } = await sb().from('tenants').select('id').eq('slug', tenant_slug).single();
      if (tenant) {
        await sb().from('stripe_subscriptions').upsert({
          tenant_id: tenant.id, stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription, plan, status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id' });
        await sb().from('tenants').update({ plan }).eq('id', tenant.id);
      }
    }
  }
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await sb().from('stripe_subscriptions').update({
      status: sub.status,
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    }).eq('stripe_subscription_id', sub.id);
  }
  res.json({ received: true });
});

module.exports = { billingRouter: router, PLANS };
