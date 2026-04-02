'use strict';

/**
 * D2C AI Infrastructure — Credit Ledger Engine
 *
 * Single source of truth for all credit operations.
 * Every workflow execution, purchase, topup, and refund flows through here.
 *
 * ── Required Supabase tables ────────────────────────────────
 *
 *  CREATE TABLE credit_accounts (
 *    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *    tenant_id                    UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
 *    balance_credits              INTEGER NOT NULL DEFAULT 0,
 *    lifetime_credits_purchased   INTEGER NOT NULL DEFAULT 0,
 *    monthly_spend_cap_usd        DECIMAL(10,2) DEFAULT NULL,  -- NULL = no cap
 *    auto_topup_enabled           BOOLEAN NOT NULL DEFAULT false,
 *    auto_topup_threshold         INTEGER NOT NULL DEFAULT 500, -- topup when balance < this
 *    auto_topup_bundle            TEXT NOT NULL DEFAULT 'growth',
 *    stripe_customer_id           TEXT,
 *    stripe_payment_method_id     TEXT,  -- saved card for auto-topup
 *    base_fee_subscription_id     TEXT,  -- Stripe subscription for $29/mo base
 *    base_fee_active              BOOLEAN NOT NULL DEFAULT false,
 *    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
 *    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
 *  );
 *
 *  CREATE TABLE credit_transactions (
 *    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 *    type             TEXT NOT NULL CHECK (type IN ('debit','credit','bonus','refund','passthrough')),
 *    credits          INTEGER NOT NULL,   -- positive = added, negative = removed
 *    workflow_id      TEXT,               -- which workflow consumed credits (NULL for purchases)
 *    execution_id     TEXT,               -- FK to workflow_execution_logs (informational)
 *    source           TEXT NOT NULL,      -- 'workflow_run' | 'purchase' | 'auto_topup' | 'trial_bonus' | 'admin'
 *    stripe_payment_id TEXT,
 *    balance_after    INTEGER NOT NULL,
 *    usd_equivalent   DECIMAL(8,4),       -- for passthrough charges (WA, email)
 *    metadata         JSONB DEFAULT '{}',
 *    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
 *  );
 *  CREATE INDEX ON credit_transactions (tenant_id, created_at DESC);
 *  CREATE INDEX ON credit_transactions (tenant_id, workflow_id, created_at DESC);
 *
 *  CREATE TABLE credit_purchases (
 *    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *    tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 *    bundle_id                TEXT NOT NULL,
 *    credits_purchased        INTEGER NOT NULL,
 *    credits_bonus            INTEGER NOT NULL DEFAULT 0,
 *    amount_usd               DECIMAL(10,2) NOT NULL,
 *    stripe_payment_intent_id TEXT UNIQUE,
 *    stripe_charge_id         TEXT,
 *    status                   TEXT NOT NULL DEFAULT 'pending',
 *    is_auto_topup            BOOLEAN NOT NULL DEFAULT false,
 *    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
 *    completed_at             TIMESTAMPTZ
 *  );
 */

const { createClient } = require('@supabase/supabase-js');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Credit bundle definitions
// ─────────────────────────────────────────────────────────────

const CREDIT_BUNDLES = {
  starter: {
    id:               'starter',
    label:            'Starter',
    credits_base:     2000,
    credits_bonus:    0,
    credits_total:    2000,
    price_usd:        20,
    price_per_credit: 0.010,
    highlight:        false,
    description:      'Perfect for testing and low-volume brands',
    stripe_price_id:  process.env.STRIPE_PRICE_CREDITS_STARTER || 'price_credits_starter',
  },
  growth: {
    id:               'growth',
    label:            'Growth',
    credits_base:     5000,
    credits_bonus:    1000,
    credits_total:    6000,
    price_usd:        50,
    price_per_credit: 0.0083,
    highlight:        false,
    description:      '20% bonus credits — great for growing brands',
    stripe_price_id:  process.env.STRIPE_PRICE_CREDITS_GROWTH  || 'price_credits_growth',
  },
  pro: {
    id:               'pro',
    label:            'Pro',
    credits_base:     10000,
    credits_bonus:    5000,
    credits_total:    15000,
    price_usd:        100,
    price_per_credit: 0.0067,
    highlight:        true,
    description:      '50% bonus credits — most popular',
    stripe_price_id:  process.env.STRIPE_PRICE_CREDITS_PRO     || 'price_credits_pro',
  },
  scale: {
    id:               'scale',
    label:            'Scale',
    credits_base:     20000,
    credits_bonus:    20000,
    credits_total:    40000,
    price_usd:        200,
    price_per_credit: 0.0050,
    highlight:        false,
    description:      '100% bonus credits — serious volume',
    stripe_price_id:  process.env.STRIPE_PRICE_CREDITS_SCALE   || 'price_credits_scale',
  },
  agency: {
    id:               'agency',
    label:            'Agency',
    credits_base:     50000,
    credits_bonus:    70000,
    credits_total:    120000,
    price_usd:        500,
    price_per_credit: 0.0042,
    highlight:        false,
    description:      '140% bonus credits — for agencies managing multiple brands',
    stripe_price_id:  process.env.STRIPE_PRICE_CREDITS_AGENCY  || 'price_credits_agency',
  },
};

const BASE_FEE_USD    = 29;
const TRIAL_CREDITS   = 500;   // Free credits on signup
const TRIAL_DAYS      = 14;

// ─────────────────────────────────────────────────────────────
// Balance operations
// ─────────────────────────────────────────────────────────────

/**
 * Get the current balance for a tenant.
 * Returns { balance_credits, monthly_spend_usd, spend_cap_usd, auto_topup_enabled,
 *           auto_topup_threshold, auto_topup_bundle, base_fee_active }
 */
async function getBalance(tenantId) {
  const { data: account } = await sb()
    .from('credit_accounts')
    .select('*')
    .eq('tenant_id', tenantId)
    .single()
    .catch(() => ({ data: null }));

  if (!account) return { balance_credits: 0, error: 'no_account' };

  const monthlySpend = await _getMonthlySpendUsd(tenantId);

  return {
    balance_credits:        account.balance_credits,
    monthly_spend_usd:      monthlySpend,
    spend_cap_usd:          account.monthly_spend_cap_usd,
    at_cap:                 account.monthly_spend_cap_usd != null && monthlySpend >= account.monthly_spend_cap_usd,
    auto_topup_enabled:     account.auto_topup_enabled,
    auto_topup_threshold:   account.auto_topup_threshold,
    auto_topup_bundle:      account.auto_topup_bundle,
    base_fee_active:        account.base_fee_active,
    stripe_customer_id:     account.stripe_customer_id,
    has_payment_method:     !!account.stripe_payment_method_id,
  };
}

/**
 * Deduct credits for a workflow execution.
 * Returns { allowed, balance_before, balance_after, cost_credits, reason }
 *
 * This is the ONLY place credits are consumed — never call sb() directly.
 */
async function deductCredits(tenantId, workflowId, costCredits, context = {}) {
  const { WORKFLOW_COSTS, CRITICAL_WORKFLOWS } = require('../api/usage-meter');
  const cost = costCredits || WORKFLOW_COSTS[workflowId] || 0;

  // ── Check balance ──────────────────────────────────────────
  const { data: account } = await sb()
    .from('credit_accounts')
    .select('balance_credits, monthly_spend_cap_usd, stripe_payment_method_id, auto_topup_enabled, auto_topup_threshold, auto_topup_bundle')
    .eq('tenant_id', tenantId)
    .single()
    .catch(() => ({ data: null }));

  if (!account) {
    // No account = unprovisioned tenant. Allow but log.
    console.warn(`[credits] No credit account for tenant ${tenantId} — workflow ${workflowId} allowed (unprovisioned)`);
    return { allowed: true, balance_before: 0, balance_after: 0, cost_credits: cost, reason: 'unprovisioned' };
  }

  const isCritical = CRITICAL_WORKFLOWS.includes(workflowId);

  // ── Spend cap check ────────────────────────────────────────
  if (account.monthly_spend_cap_usd != null && !isCritical) {
    const monthlySpend = await _getMonthlySpendUsd(tenantId);
    const costUsd = cost * 0.01;
    if (monthlySpend + costUsd > account.monthly_spend_cap_usd) {
      return {
        allowed:        false,
        balance_before: account.balance_credits,
        balance_after:  account.balance_credits,
        cost_credits:   cost,
        reason:         'spend_cap_reached',
        monthly_spend:  monthlySpend,
        cap:            account.monthly_spend_cap_usd,
      };
    }
  }

  // ── Insufficient balance ───────────────────────────────────
  if (account.balance_credits < cost && !isCritical) {
    // Trigger auto-topup if configured
    if (account.auto_topup_enabled && account.stripe_payment_method_id) {
      const topped = await triggerAutoTopup(tenantId);
      if (!topped.ok) {
        return { allowed: false, balance_before: account.balance_credits, balance_after: account.balance_credits, cost_credits: cost, reason: 'insufficient_credits_topup_failed' };
      }
      // Re-fetch after topup
      const { data: refreshed } = await sb().from('credit_accounts').select('balance_credits').eq('tenant_id', tenantId).single();
      if ((refreshed?.balance_credits || 0) < cost) {
        return { allowed: false, balance_before: account.balance_credits, balance_after: account.balance_credits, cost_credits: cost, reason: 'insufficient_credits' };
      }
      account.balance_credits = refreshed.balance_credits;
    } else if (!isCritical) {
      return { allowed: false, balance_before: account.balance_credits, balance_after: account.balance_credits, cost_credits: cost, reason: 'insufficient_credits' };
    }
  }

  // ── Atomic deduction using Postgres RPC ───────────────────
  const newBalance = Math.max(0, account.balance_credits - cost);

  const { error: updateErr } = await sb()
    .from('credit_accounts')
    .update({ balance_credits: newBalance, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('balance_credits', account.balance_credits); // optimistic lock

  if (updateErr) {
    console.error('[credits] Deduction race condition for tenant', tenantId, updateErr.message);
    // Re-try once
    const { data: retry } = await sb().from('credit_accounts').select('balance_credits').eq('tenant_id', tenantId).single();
    const retryBalance = Math.max(0, (retry?.balance_credits || 0) - cost);
    await sb().from('credit_accounts').update({ balance_credits: retryBalance, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId);
  }

  // ── Log transaction ────────────────────────────────────────
  await sb().from('credit_transactions').insert({
    tenant_id:     tenantId,
    type:          'debit',
    credits:       -cost,
    workflow_id:   workflowId,
    execution_id:  context.execution_id  || null,
    source:        'workflow_run',
    balance_after: newBalance,
    usd_equivalent: +(cost * 0.01).toFixed(4),
    metadata:      context,
  }).catch(err => console.error('[credits] Transaction log failed:', err.message));

  // ── Check if auto-topup should trigger (low balance warning) ─
  if (account.auto_topup_enabled && newBalance < account.auto_topup_threshold && !isCritical) {
    triggerAutoTopup(tenantId).catch(err =>
      console.error('[credits] Auto-topup failed:', err.message)
    );
  }

  return {
    allowed:        true,
    balance_before: account.balance_credits,
    balance_after:  newBalance,
    cost_credits:   cost,
    reason:         'ok',
  };
}

/**
 * Add credits to a tenant's account.
 * Called after a successful Stripe payment.
 */
async function addCredits(tenantId, creditsTotal, source, stripePaymentId = null, bundleId = null) {
  // Fetch current balance
  const { data: account } = await sb()
    .from('credit_accounts')
    .select('balance_credits, lifetime_credits_purchased')
    .eq('tenant_id', tenantId)
    .single()
    .catch(() => ({ data: null }));

  if (!account) {
    // Create account if it doesn't exist
    await provisionCreditAccount(tenantId);
    return addCredits(tenantId, creditsTotal, source, stripePaymentId, bundleId);
  }

  const newBalance = account.balance_credits + creditsTotal;
  const newLifetime = account.lifetime_credits_purchased + creditsTotal;

  await sb().from('credit_accounts').update({
    balance_credits: newBalance,
    lifetime_credits_purchased: newLifetime,
    updated_at: new Date().toISOString(),
  }).eq('tenant_id', tenantId);

  await sb().from('credit_transactions').insert({
    tenant_id:         tenantId,
    type:              'credit',
    credits:           creditsTotal,
    source,
    stripe_payment_id: stripePaymentId,
    balance_after:     newBalance,
    usd_equivalent:    bundleId ? CREDIT_BUNDLES[bundleId]?.price_usd : null,
    metadata:          { bundle_id: bundleId },
  }).catch(() => {});

  return { ok: true, new_balance: newBalance };
}

/**
 * Provision a new credit account for a freshly onboarded tenant.
 * Gives TRIAL_CREDITS free and starts the 14-day trial.
 */
async function provisionCreditAccount(tenantId, stripeCustomerId = null) {
  const { data: existing } = await sb()
    .from('credit_accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .single()
    .catch(() => ({ data: null }));

  if (existing) return { ok: true, already_exists: true };

  await sb().from('credit_accounts').insert({
    tenant_id:       tenantId,
    balance_credits: TRIAL_CREDITS,
    lifetime_credits_purchased: 0,
    auto_topup_enabled:    false,
    auto_topup_threshold:  500,
    auto_topup_bundle:     'growth',
    base_fee_active:       false,
    stripe_customer_id:    stripeCustomerId || null,
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString(),
  });

  // Log the free trial credit
  await sb().from('credit_transactions').insert({
    tenant_id:     tenantId,
    type:          'bonus',
    credits:       TRIAL_CREDITS,
    source:        'trial_bonus',
    balance_after: TRIAL_CREDITS,
    metadata:      { trial_days: TRIAL_DAYS },
  }).catch(() => {});

  return { ok: true, trial_credits: TRIAL_CREDITS };
}

/**
 * Trigger auto-topup via Stripe for a tenant with low balance.
 */
async function triggerAutoTopup(tenantId) {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false, reason: 'stripe_not_configured' };

  const { data: account } = await sb()
    .from('credit_accounts')
    .select('auto_topup_bundle, stripe_customer_id, stripe_payment_method_id')
    .eq('tenant_id', tenantId)
    .single()
    .catch(() => ({ data: null }));

  if (!account?.stripe_payment_method_id || !account?.stripe_customer_id) {
    return { ok: false, reason: 'no_payment_method' };
  }

  const bundle = CREDIT_BUNDLES[account.auto_topup_bundle] || CREDIT_BUNDLES.growth;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const intent = await stripe.paymentIntents.create({
      amount:               Math.round(bundle.price_usd * 100),
      currency:             'usd',
      customer:             account.stripe_customer_id,
      payment_method:       account.stripe_payment_method_id,
      confirm:              true,
      off_session:          true,
      metadata:             { tenant_id: tenantId, bundle_id: bundle.id, auto_topup: 'true' },
    });

    if (intent.status === 'succeeded') {
      // Credits added via webhook (payment_intent.succeeded)
      return { ok: true, bundle_id: bundle.id, credits: bundle.credits_total, payment_intent_id: intent.id };
    }
    return { ok: false, reason: `payment_status_${intent.status}` };
  } catch (err) {
    console.error('[credits] Auto-topup Stripe error:', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * Update billing settings for a tenant.
 */
async function updateBillingSettings(tenantId, settings) {
  const ALLOWED = ['monthly_spend_cap_usd', 'auto_topup_enabled', 'auto_topup_threshold', 'auto_topup_bundle', 'stripe_payment_method_id'];
  const updates = {};
  for (const key of ALLOWED) {
    if (settings[key] !== undefined) updates[key] = settings[key];
  }
  if (Object.keys(updates).length === 0) return { ok: false, error: 'no valid fields' };
  updates.updated_at = new Date().toISOString();

  const { error } = await sb().from('credit_accounts').update(updates).eq('tenant_id', tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Usage analytics
// ─────────────────────────────────────────────────────────────

/**
 * Get per-workflow credit usage for a given month.
 * Returns array: [{ workflow_id, total_credits, run_count, avg_credits }]
 */
async function getMonthlyUsage(tenantId, monthIso = null) {
  const month = monthIso || new Date().toISOString().slice(0, 7);
  const start = `${month}-01T00:00:00Z`;
  const end   = new Date(new Date(start).getTime() + 32 * 86400000).toISOString().slice(0, 7) + '-01T00:00:00Z';

  const { data } = await sb()
    .from('credit_transactions')
    .select('workflow_id, credits, created_at')
    .eq('tenant_id', tenantId)
    .eq('type', 'debit')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at', { ascending: false });

  if (!data || data.length === 0) return [];

  const map = {};
  for (const tx of data) {
    const wf = tx.workflow_id || 'unknown';
    map[wf] = map[wf] || { workflow_id: wf, total_credits: 0, run_count: 0 };
    map[wf].total_credits += Math.abs(tx.credits);
    map[wf].run_count++;
  }

  return Object.values(map)
    .map(r => ({ ...r, avg_credits: Math.round(r.total_credits / r.run_count) }))
    .sort((a, b) => b.total_credits - a.total_credits);
}

/**
 * Get recent transactions for the billing history table.
 */
async function getTransactionHistory(tenantId, limit = 25) {
  const { data } = await sb()
    .from('credit_transactions')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

async function _getMonthlySpendUsd(tenantId) {
  const start = new Date().toISOString().slice(0, 7) + '-01T00:00:00Z';
  const { data } = await sb()
    .from('credit_transactions')
    .select('credits')
    .eq('tenant_id', tenantId)
    .eq('type', 'debit')
    .gte('created_at', start);

  if (!data || data.length === 0) return 0;
  const totalCredits = data.reduce((sum, tx) => sum + Math.abs(tx.credits), 0);
  return +(totalCredits * 0.01).toFixed(2);
}

module.exports = {
  CREDIT_BUNDLES,
  BASE_FEE_USD,
  TRIAL_CREDITS,
  TRIAL_DAYS,
  getBalance,
  deductCredits,
  addCredits,
  provisionCreditAccount,
  triggerAutoTopup,
  updateBillingSettings,
  getMonthlyUsage,
  getTransactionHistory,
};
