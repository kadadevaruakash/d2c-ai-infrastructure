'use strict';

/**
 * D2C AI Infrastructure — Billing View
 *
 * Renders the full billing page: balance hero, buy-credits panel,
 * usage breakdown, settings, and transaction history.
 *
 * Called from app.js VIEW_RENDERERS['billing'].
 * Expects window.APP_STATE.currentSlug and window.d2cApi to be set.
 */

// ─────────────────────────────────────────────────────────────
// Workflow cost catalogue (mirrors api/usage-meter.js)
// ─────────────────────────────────────────────────────────────

const WORKFLOW_META = {
  'A-01': { label: 'Lead Capture & Score',       category: 'Acquire',      cost: 5  },
  'A-02': { label: 'Cold Email Outreach',         category: 'Acquire',      cost: 4  },
  'A-03': { label: 'Instagram DM Intent',         category: 'Acquire',      cost: 3  },
  'A-04': { label: 'SEO Content Generation',      category: 'Acquire',      cost: 25 },
  'C-01': { label: 'Cart Recovery',               category: 'Convert',      cost: 2  },
  'C-02': { label: 'Inventory Drop Alert',        category: 'Convert',      cost: 2  },
  'C-03': { label: 'Amazon PDP Optimiser',        category: 'Convert',      cost: 3  },
  'C-04': { label: 'Gamified Checkout',           category: 'Convert',      cost: 3  },
  'I-01': { label: 'Competitor Tracker',          category: 'Intelligence', cost: 8  },
  'I-02': { label: 'Revenue Reports',             category: 'Intelligence', cost: 6  },
  'I-03': { label: 'Customer Intel (per event)',  category: 'Intelligence', cost: 4  },
  'I-03-SCAN': { label: 'Cold Lead Batch Scan',   category: 'Intelligence', cost: 15 },
  'I-04': { label: 'Tax Compliance Report',       category: 'Intelligence', cost: 10 },
  'R-01': { label: 'CRM Follow-up',               category: 'Retain',       cost: 2  },
  'R-02': { label: 'Loyalty Engine',              category: 'Retain',       cost: 2  },
  'R-03': { label: 'Social Auto-Post',            category: 'Retain',       cost: 4  },
  'R-04': { label: 'Winback Email',               category: 'Retain',       cost: 4  },
  'S-01': { label: 'WhatsApp Support',            category: 'Support',      cost: 3  },
  'S-02': { label: 'RAG Brain Query',             category: 'Support',      cost: 5  },
  'S-03': { label: 'Review Sentiment',            category: 'Support',      cost: 4  },
  'S-04': { label: 'CEO Alert',                   category: 'Support',      cost: 2  },
  'SC-01': { label: 'UGC Collector',              category: 'Scale',        cost: 4  },
  'SC-02': { label: 'Funnel Analytics',           category: 'Scale',        cost: 8  },
  'SC-03': { label: 'Sales Qualification',        category: 'Scale',        cost: 5  },
  'SC-04': { label: 'SEO Meta Generator',         category: 'Scale',        cost: 12 },
};

const CRITICAL_WORKFLOWS = ['S-01', 'S-04', 'C-01', 'I-04'];

const CATEGORY_COLORS = {
  Acquire:      '#6366f1',
  Convert:      '#f59e0b',
  Intelligence: '#10b981',
  Retain:       '#3b82f6',
  Support:      '#ef4444',
  Scale:        '#8b5cf6',
};

// ─────────────────────────────────────────────────────────────
// Entry point — called by app.js
// ─────────────────────────────────────────────────────────────

async function renderBillingView(container, slug) {
  container.innerHTML = `<div class="billing-loading">Loading billing data…</div>`;

  const [balanceRes, usageRes, txnRes, plansRes] = await Promise.all([
    window.d2cApi(`/api/billing/balance/${slug}`).catch(() => null),
    window.d2cApi(`/api/billing/usage/${slug}`).catch(() => null),
    window.d2cApi(`/api/billing/transactions/${slug}`).catch(() => null),
    window.d2cApi('/api/billing/plans').catch(() => null),
  ]);

  const balance  = balanceRes  || _mockBalance();
  const usage    = (usageRes?.usage)  || _mockUsage();
  const txns     = (txnRes?.transactions) || _mockTransactions();
  const plans    = plansRes    || _mockPlans();

  container.innerHTML = `
    <div class="billing-page">
      ${_renderHero(balance)}
      ${_renderBundles(plans, balance)}
      ${_renderUsage(usage)}
      ${_renderSettings(balance)}
      ${_renderHistory(txns)}
    </div>
  `;

  _attachEventHandlers(container, slug, balance, plans);
}

// ─────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────

function _renderHero(balance) {
  const pct = balance.spend_cap_usd
    ? Math.min(100, Math.round((balance.monthly_spend_usd / balance.spend_cap_usd) * 100))
    : null;

  const capBar = pct !== null ? `
    <div class="spend-cap-bar-wrap">
      <div class="spend-cap-label">
        Monthly spend: <strong>$${balance.monthly_spend_usd.toFixed(2)}</strong>
        of <strong>$${balance.spend_cap_usd}</strong> cap
      </div>
      <div class="spend-cap-track">
        <div class="spend-cap-fill ${pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : ''}"
             style="width:${pct}%"></div>
      </div>
    </div>` : '';

  const statusBadge = balance.base_fee_active
    ? `<span class="badge badge-green">Active</span>`
    : `<span class="badge badge-orange">Trial</span>`;

  return `
    <section class="billing-hero">
      <div class="hero-main">
        <div class="hero-balance">
          <span class="balance-number">${balance.balance_credits.toLocaleString()}</span>
          <span class="balance-label">credits remaining</span>
          <span class="balance-usd">≈ $${(balance.balance_credits * 0.01).toFixed(2)}</span>
        </div>
        <div class="hero-meta">
          <div class="hero-stat">
            <span class="stat-label">This month's spend</span>
            <span class="stat-value">$${balance.monthly_spend_usd.toFixed(2)}</span>
          </div>
          <div class="hero-stat">
            <span class="stat-label">Base plan</span>
            <span class="stat-value">$29/mo ${statusBadge}</span>
          </div>
          <div class="hero-stat">
            <span class="stat-label">Auto-topup</span>
            <span class="stat-value">${balance.auto_topup_enabled ? `<span class="badge badge-green">On — ${balance.auto_topup_bundle}</span>` : '<span class="badge badge-grey">Off</span>'}</span>
          </div>
        </div>
      </div>
      ${capBar}
      ${!balance.base_fee_active ? `
        <div class="hero-trial-banner">
          You are on a free trial. Subscribe to the $29/mo base plan to keep access after your trial credits run out.
          <button class="btn btn-primary btn-sm" data-action="subscribe-base">Subscribe — $29/mo</button>
        </div>` : ''}
    </section>
  `;
}

function _renderBundles(plans, balance) {
  const bundles = plans.bundles || [];

  const cards = bundles.map(b => {
    const bonusPct = b.credits_bonus > 0 ? Math.round((b.credits_bonus / b.credits_base) * 100) : 0;
    const bonusBadge = bonusPct > 0
      ? `<div class="bundle-bonus">+${bonusPct}% bonus</div>`
      : '';
    return `
      <div class="bundle-card ${b.highlight ? 'highlighted' : ''}" data-bundle="${b.id}">
        ${b.highlight ? '<div class="bundle-popular">Most Popular</div>' : ''}
        ${bonusBadge}
        <div class="bundle-label">${b.label}</div>
        <div class="bundle-price">$${b.price_usd}</div>
        <div class="bundle-credits">${b.credits_total.toLocaleString()} credits</div>
        <div class="bundle-rate">$${(b.price_per_credit).toFixed(4)}/credit</div>
        <div class="bundle-desc">${b.description}</div>
        <button class="btn ${b.highlight ? 'btn-primary' : 'btn-secondary'} bundle-buy-btn"
                data-bundle="${b.id}" data-price="${b.price_usd}" data-credits="${b.credits_total}">
          Buy credits
        </button>
      </div>
    `;
  }).join('');

  return `
    <section class="billing-section">
      <h2 class="section-title">Buy Credits</h2>
      <p class="section-sub">1 credit = $0.01 · Credits never expire · All 24 workflows included</p>
      <div class="credit-bundles">${cards}</div>
    </section>
  `;
}

function _renderUsage(usage) {
  if (!usage || usage.length === 0) {
    return `
      <section class="billing-section">
        <h2 class="section-title">Usage This Month</h2>
        <p class="section-empty">No workflow runs recorded this month.</p>
      </section>
    `;
  }

  const totalCredits = usage.reduce((s, r) => s + r.total_credits, 0);

  const rows = usage.map(row => {
    const meta = WORKFLOW_META[row.workflow_id] || { label: row.workflow_id, category: 'Other', cost: 0 };
    const pct  = totalCredits > 0 ? Math.round((row.total_credits / totalCredits) * 100) : 0;
    const color = CATEGORY_COLORS[meta.category] || '#6b7280';
    const critical = CRITICAL_WORKFLOWS.includes(row.workflow_id)
      ? `<span class="badge badge-red badge-xs" title="Always runs even at zero balance">critical</span>`
      : '';
    return `
      <tr>
        <td>
          <span class="usage-dot" style="background:${color}"></span>
          ${meta.label} ${critical}
        </td>
        <td><span class="category-pill" style="--cat-color:${color}">${meta.category}</span></td>
        <td class="num">${row.run_count.toLocaleString()}</td>
        <td class="num">${row.total_credits.toLocaleString()}</td>
        <td class="num">$${(row.total_credits * 0.01).toFixed(2)}</td>
        <td>
          <div class="usage-bar-wrap">
            <div class="usage-bar" style="width:${pct}%;background:${color}"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <section class="billing-section">
      <h2 class="section-title">Usage This Month
        <span class="title-meta">${totalCredits.toLocaleString()} credits · $${(totalCredits * 0.01).toFixed(2)}</span>
      </h2>
      <div class="table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Workflow</th><th>Category</th>
              <th class="num">Runs</th><th class="num">Credits</th>
              <th class="num">Cost</th><th>Share</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function _renderSettings(balance) {
  const bundles = ['starter','growth','pro','scale','agency'];
  const bundleOpts = bundles.map(b =>
    `<option value="${b}" ${balance.auto_topup_bundle === b ? 'selected' : ''}>${b.charAt(0).toUpperCase() + b.slice(1)}</option>`
  ).join('');

  const capVal = balance.spend_cap_usd != null ? balance.spend_cap_usd : '';

  return `
    <section class="billing-section">
      <h2 class="section-title">Auto-Topup & Spend Controls</h2>
      <div class="settings-grid">

        <div class="settings-card">
          <h3>Auto-Topup</h3>
          <p>Automatically purchase credits when your balance drops below a threshold. Requires a saved payment method.</p>
          <label class="toggle-row">
            <span>Enable auto-topup</span>
            <label class="toggle">
              <input type="checkbox" id="auto-topup-toggle" ${balance.auto_topup_enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </label>
          <div class="settings-field">
            <label>Top-up when balance falls below</label>
            <div class="input-suffix">
              <input type="number" id="topup-threshold" value="${balance.auto_topup_threshold}" min="100" max="10000" step="100">
              <span>credits</span>
            </div>
          </div>
          <div class="settings-field">
            <label>Bundle to purchase</label>
            <select id="topup-bundle">${bundleOpts}</select>
          </div>
          ${!balance.has_payment_method ? `
            <p class="settings-note settings-note-warn">
              No saved payment method. Purchase credits once with "Save card" to enable auto-topup.
            </p>` : `<p class="settings-note settings-note-ok">Payment method saved.</p>`}
          <button class="btn btn-primary btn-sm" data-action="save-topup-settings">Save settings</button>
        </div>

        <div class="settings-card">
          <h3>Monthly Spend Cap</h3>
          <p>Block new workflow runs (except critical ones) once you've spent this amount in a calendar month. Leave blank for no cap.</p>
          <div class="settings-field">
            <label>Cap (USD)</label>
            <div class="input-suffix">
              <span>$</span>
              <input type="number" id="spend-cap" value="${capVal}" min="10" step="10" placeholder="No cap">
            </div>
          </div>
          <p class="settings-note">Critical workflows (Customer Support, CEO Alerts, Cart Recovery, Tax Compliance) always run regardless of cap.</p>
          <button class="btn btn-primary btn-sm" data-action="save-cap-settings">Save cap</button>
        </div>

      </div>
    </section>
  `;
}

function _renderHistory(txns) {
  if (!txns || txns.length === 0) {
    return `
      <section class="billing-section">
        <h2 class="section-title">Transaction History</h2>
        <p class="section-empty">No transactions yet.</p>
      </section>
    `;
  }

  const TYPE_LABELS = {
    debit:       { label: 'Workflow run',   cls: 'badge-red'    },
    credit:      { label: 'Purchase',       cls: 'badge-green'  },
    bonus:       { label: 'Bonus',          cls: 'badge-purple' },
    refund:      { label: 'Refund',         cls: 'badge-blue'   },
    passthrough: { label: 'Pass-through',   cls: 'badge-grey'   },
  };

  const rows = txns.map(tx => {
    const meta    = TYPE_LABELS[tx.type] || { label: tx.type, cls: 'badge-grey' };
    const wfMeta  = tx.workflow_id ? WORKFLOW_META[tx.workflow_id] : null;
    const wfLabel = wfMeta ? wfMeta.label : (tx.workflow_id || '—');
    const sign    = tx.credits > 0 ? '+' : '';
    const dateStr = new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <tr>
        <td>${dateStr}</td>
        <td><span class="badge ${meta.cls}">${meta.label}</span></td>
        <td>${wfLabel}</td>
        <td class="num ${tx.credits > 0 ? 'text-green' : 'text-red'}">${sign}${tx.credits.toLocaleString()}</td>
        <td class="num">${tx.balance_after.toLocaleString()}</td>
      </tr>
    `;
  }).join('');

  return `
    <section class="billing-section">
      <h2 class="section-title">Transaction History</h2>
      <div class="table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Workflow</th>
              <th class="num">Credits</th><th class="num">Balance after</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

// ─────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────

function _attachEventHandlers(container, slug, balance, plans) {
  // Buy credits buttons
  container.querySelectorAll('.bundle-buy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bundleId = btn.dataset.bundle;
      _purchaseCredits(slug, bundleId, plans);
    });
  });

  // Subscribe to base fee
  container.querySelectorAll('[data-action="subscribe-base"]').forEach(btn => {
    btn.addEventListener('click', () => _subscribeBase(slug));
  });

  // Save topup settings
  container.querySelectorAll('[data-action="save-topup-settings"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const enabled   = container.querySelector('#auto-topup-toggle')?.checked ?? false;
      const threshold = parseInt(container.querySelector('#topup-threshold')?.value) || 500;
      const bundle    = container.querySelector('#topup-bundle')?.value || 'growth';
      _saveSettings(slug, { auto_topup_enabled: enabled, auto_topup_threshold: threshold, auto_topup_bundle: bundle }, btn);
    });
  });

  // Save spend cap
  container.querySelectorAll('[data-action="save-cap-settings"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = container.querySelector('#spend-cap')?.value;
      const cap = raw ? parseFloat(raw) : null;
      _saveSettings(slug, { monthly_spend_cap_usd: cap }, btn);
    });
  });
}

async function _purchaseCredits(slug, bundleId, plans) {
  const bundle = (plans.bundles || []).find(b => b.id === bundleId);
  if (!bundle) return;

  const confirmed = window.confirm(
    `Purchase ${bundle.credits_total.toLocaleString()} credits for $${bundle.price_usd}?\n` +
    `(${bundle.description})`
  );
  if (!confirmed) return;

  try {
    const result = await window.d2cApi('/api/billing/purchase-credits', {
      method: 'POST',
      body: JSON.stringify({ tenant_slug: slug, bundle_id: bundleId, save_payment_method: true }),
    });

    if (result.client_secret) {
      // In production: use Stripe.js to confirm the payment with the client_secret.
      // In demo mode, we show the payment intent ID as a confirmation.
      window.alert(
        `Payment initiated!\n` +
        `Amount: $${bundle.price_usd}\n` +
        `Credits: ${bundle.credits_total.toLocaleString()}\n\n` +
        `In production, Stripe.js would open the card payment form here.\n` +
        `Payment Intent: ${result.payment_intent_id}`
      );
    }
  } catch (err) {
    window.alert(`Purchase failed: ${err.message}`);
  }
}

async function _subscribeBase(slug) {
  try {
    const result = await window.d2cApi('/api/billing/base-fee-subscribe', {
      method: 'POST',
      body: JSON.stringify({ tenant_slug: slug }),
    });
    if (result.checkout_url) {
      window.location.href = result.checkout_url;
    }
  } catch (err) {
    window.alert(`Subscription failed: ${err.message}`);
  }
}

async function _saveSettings(slug, settings, btn) {
  const original = btn.textContent;
  btn.textContent = 'Saving…';
  btn.disabled = true;

  try {
    await window.d2cApi(`/api/billing/settings/${slug}`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
  } catch (err) {
    btn.textContent = 'Error — retry';
    btn.disabled = false;
    console.error('[billing-view] save settings failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Mock data (used when API is unavailable / demo mode)
// ─────────────────────────────────────────────────────────────

function _mockBalance() {
  return {
    balance_credits:      2840,
    monthly_spend_usd:    14.20,
    spend_cap_usd:        50,
    at_cap:               false,
    auto_topup_enabled:   false,
    auto_topup_threshold: 500,
    auto_topup_bundle:    'growth',
    base_fee_active:      false,
    has_payment_method:   false,
  };
}

function _mockUsage() {
  return [
    { workflow_id: 'A-01', run_count: 87,  total_credits: 435, avg_credits: 5  },
    { workflow_id: 'C-01', run_count: 44,  total_credits: 88,  avg_credits: 2  },
    { workflow_id: 'I-03', run_count: 62,  total_credits: 248, avg_credits: 4  },
    { workflow_id: 'SC-04', run_count: 12, total_credits: 144, avg_credits: 12 },
    { workflow_id: 'R-04', run_count: 23,  total_credits: 92,  avg_credits: 4  },
    { workflow_id: 'S-02', run_count: 19,  total_credits: 95,  avg_credits: 5  },
    { workflow_id: 'A-04', run_count: 4,   total_credits: 100, avg_credits: 25 },
    { workflow_id: 'I-01', run_count: 10,  total_credits: 80,  avg_credits: 8  },
    { workflow_id: 'S-01', run_count: 38,  total_credits: 114, avg_credits: 3  },
    { workflow_id: 'SC-03', run_count: 29, total_credits: 145, avg_credits: 5  },
  ];
}

function _mockTransactions() {
  const now = Date.now();
  return [
    { id: '1', type: 'credit', credits: 6000,  workflow_id: null,   source: 'purchase',     balance_after: 6000,  created_at: new Date(now - 5 * 86400000).toISOString() },
    { id: '2', type: 'debit',  credits: -5,    workflow_id: 'A-01', source: 'workflow_run', balance_after: 5995,  created_at: new Date(now - 5 * 86400000 + 3600000).toISOString() },
    { id: '3', type: 'debit',  credits: -4,    workflow_id: 'A-02', source: 'workflow_run', balance_after: 5991,  created_at: new Date(now - 4 * 86400000).toISOString() },
    { id: '4', type: 'debit',  credits: -25,   workflow_id: 'A-04', source: 'workflow_run', balance_after: 5966,  created_at: new Date(now - 3 * 86400000).toISOString() },
    { id: '5', type: 'debit',  credits: -2,    workflow_id: 'C-01', source: 'workflow_run', balance_after: 5964,  created_at: new Date(now - 3 * 86400000 + 7200000).toISOString() },
    { id: '6', type: 'refund', credits: 25,    workflow_id: 'A-04', source: 'workflow_run', balance_after: 5989,  created_at: new Date(now - 2 * 86400000).toISOString() },
    { id: '7', type: 'bonus',  credits: 500,   workflow_id: null,   source: 'trial_bonus',  balance_after: 500,   created_at: new Date(now - 10 * 86400000).toISOString() },
    { id: '8', type: 'debit',  credits: -12,   workflow_id: 'SC-04', source: 'workflow_run', balance_after: 2840, created_at: new Date(now - 1 * 86400000).toISOString() },
  ];
}

function _mockPlans() {
  return {
    base_fee_usd: 29,
    bundles: [
      { id: 'starter', label: 'Starter', credits_base: 2000,  credits_bonus: 0,     credits_total: 2000,   price_usd: 20,  price_per_credit: 0.010,  highlight: false, description: 'Perfect for testing and low-volume brands' },
      { id: 'growth',  label: 'Growth',  credits_base: 5000,  credits_bonus: 1000,  credits_total: 6000,   price_usd: 50,  price_per_credit: 0.0083, highlight: false, description: '20% bonus credits — great for growing brands' },
      { id: 'pro',     label: 'Pro',     credits_base: 10000, credits_bonus: 5000,  credits_total: 15000,  price_usd: 100, price_per_credit: 0.0067, highlight: true,  description: '50% bonus credits — most popular' },
      { id: 'scale',   label: 'Scale',   credits_base: 20000, credits_bonus: 20000, credits_total: 40000,  price_usd: 200, price_per_credit: 0.0050, highlight: false, description: '100% bonus credits — serious volume' },
      { id: 'agency',  label: 'Agency',  credits_base: 50000, credits_bonus: 70000, credits_total: 120000, price_usd: 500, price_per_credit: 0.0042, highlight: false, description: '140% bonus credits — for agencies managing multiple brands' },
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────

window.billingView = { renderBillingView };
