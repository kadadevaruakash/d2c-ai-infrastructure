/**
 * D2C AI Infrastructure — White-Label Brand Configuration
 *
 * USAGE:
 *   Every n8n workflow loads its brand context by calling:
 *   GET /api/config/:tenantSlug
 *
 *   In n8n code nodes, reference as:
 *   const brand = $vars.BRAND_CONFIG;  // injected via Set node at workflow start
 *
 * WHITE-LABELING:
 *   Each client (tenant) has their own row in `tenant_config` (Supabase).
 *   This file defines the shape/defaults.
 *   The `BrandConfig` class is used by the onboarding API to create a new tenant.
 */

'use strict';

// ──────────────────────────────────────────────
// Default brand config (used as template for new clients)
// ──────────────────────────────────────────────
const BRAND_CONFIG_DEFAULTS = {
  // Identity
  brand_name: 'Your Brand',
  brand_voice: 'friendly, professional, and customer-first',
  store_url: 'https://yourstore.com',
  calendly_url: 'https://calendly.com/yourname/15min',
  logo_url: null,
  primary_color: '#000000',

  // Contact routing
  strategy_email: 'strategy@yourcompany.com',
  ops_email: 'ops@yourcompany.com',
  finance_email: 'finance@yourcompany.com',
  support_email: 'support@yourcompany.com',
  manager_email: 'manager@yourcompany.com',
  ceo_phone: null,   // WhatsApp number for CEO assistant alerts

  // Slack channels (can be overridden per client)
  slack_channels: {
    leads: '#leads',
    outreach: '#outreach',
    hot_leads: '#hot-leads',
    content: '#content-team',
    amazon: '#amazon-ops',
    launches: '#product-launches',
    analytics: '#analytics',
    revenue: '#daily-revenue',
    crm: '#crm-updates',
    retention: '#retention',
    support: '#support-escalations',
    reviews: '#reviews',
    social: '#social-media',
    ugc: '#ugc-team',
    incidents: '#incidents',
    seo: '#seo-updates',
    sales: '#sales-alerts',
    checkout: '#checkout-analytics',
    competitor: '#competitor-intel',
    finance: '#finance',
  },

  // Commerce thresholds
  free_shipping_threshold: 75.00,
  default_currency: 'USD',

  // AI model selection
  ai_model_standard: 'gpt-4o-mini',   // Used for routine tasks (email, scoring, captions)
  ai_model_premium: 'gpt-4o',          // Used for CEO briefs, blog posts, strategic analysis

  // Lead & scoring thresholds
  lead_hot_score_threshold: 70,        // Score >= this → hot lead alert

  // Cart recovery timing (minutes)
  cart_recovery_delays: {
    stage_1: 60,    // 1 hour
    stage_2: 240,   // 4 hours
    stage_3: 1440,  // 24 hours
  },

  // Winback timing (days since last order)
  winback_stages: {
    stage_1_days: 60,   // Personal note, no discount
    stage_2_days: 90,   // 10% discount
    stage_3_days: 120,  // 20% + free shipping
  },

  // Financial alert thresholds
  roas_alert_threshold: 2.0,      // Alert if ROAS drops below this
  margin_alert_threshold: 30.0,   // Alert if margin drops below this %
  revenue_drop_threshold: 20.0,   // Alert if revenue drops > this % vs prior day

  // Loyalty tier thresholds (lifetime points)
  loyalty_tiers: {
    bronze:   { min: 0,    max: 499,  discount: 0  },
    silver:   { min: 500,  max: 1499, discount: 5  },
    gold:     { min: 1500, max: 4999, discount: 10 },
    platinum: { min: 5000, max: Infinity, discount: 15 },
  },

  // Points earning rules
  loyalty_points_rules: {
    purchase_rate: 1,   // $1 spent = 1 point
    referral: 50,
    review: 25,
    social_share: 10,
    birthday: 100,
  },

  // Tax rates by jurisdiction (ISO country-state codes)
  tax_rates: {
    'US-CA': 0.0725,
    'US-NY': 0.08,
    'US-TX': 0.0625,
    'US-FL': 0.06,
    'US-WA': 0.065,
    'US-IL': 0.0625,
    'GB':    0.20,
    'EU':    0.20,
    'AU':    0.10,
    'CA':    0.05,
  },

  // Feature flags
  features: {
    amazon_pdp:    false,
    loyalty:       true,
    ugc:           true,
    gamification:  true,
    rag_support:   true,
    tax_reports:   true,
    ceo_assistant: true,
  },
};

// ──────────────────────────────────────────────
// BrandConfig class — used during onboarding
// ──────────────────────────────────────────────
class BrandConfig {
  /**
   * @param {string} tenantSlug  - URL-safe unique identifier e.g. 'nike-d2c'
   * @param {object} overrides   - Client-specific values that override defaults
   */
  constructor(tenantSlug, overrides = {}) {
    this.tenant_slug = tenantSlug;
    this.config = this._merge(BRAND_CONFIG_DEFAULTS, overrides);
  }

  _merge(defaults, overrides) {
    const result = { ...defaults };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== null && value !== undefined && value !== '') {
        if (typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object') {
          result[key] = this._merge(result[key], value);
        } else {
          result[key] = value;
        }
      }
    }
    return result;
  }

  /**
   * Returns the flat config ready to insert into `tenant_config` table
   */
  toSupabaseRow(tenantId) {
    const c = this.config;
    return {
      tenant_id:                  tenantId,
      brand_name:                 c.brand_name,
      brand_voice:                c.brand_voice,
      store_url:                  c.store_url,
      calendly_url:               c.calendly_url,
      logo_url:                   c.logo_url,
      primary_color:              c.primary_color,
      strategy_email:             c.strategy_email,
      ops_email:                  c.ops_email,
      finance_email:              c.finance_email,
      support_email:              c.support_email,
      manager_email:              c.manager_email,
      ceo_phone:                  c.ceo_phone,
      slack_channel_leads:        c.slack_channels.leads,
      slack_channel_outreach:     c.slack_channels.outreach,
      slack_channel_hot_leads:    c.slack_channels.hot_leads,
      slack_channel_content:      c.slack_channels.content,
      slack_channel_amazon:       c.slack_channels.amazon,
      slack_channel_launches:     c.slack_channels.launches,
      slack_channel_analytics:    c.slack_channels.analytics,
      slack_channel_revenue:      c.slack_channels.revenue,
      slack_channel_crm:          c.slack_channels.crm,
      slack_channel_retention:    c.slack_channels.retention,
      slack_channel_support:      c.slack_channels.support,
      slack_channel_reviews:      c.slack_channels.reviews,
      slack_channel_social:       c.slack_channels.social,
      slack_channel_ugc:          c.slack_channels.ugc,
      slack_channel_incidents:    c.slack_channels.incidents,
      slack_channel_seo:          c.slack_channels.seo,
      slack_channel_sales:        c.slack_channels.sales,
      slack_channel_checkout:     c.slack_channels.checkout,
      free_shipping_threshold:    c.free_shipping_threshold,
      default_currency:           c.default_currency,
      ai_model_standard:          c.ai_model_standard,
      ai_model_premium:           c.ai_model_premium,
      lead_hot_score_threshold:   c.lead_hot_score_threshold,
      roas_alert_threshold:       c.roas_alert_threshold,
      margin_alert_threshold:     c.margin_alert_threshold,
      revenue_drop_threshold:     c.revenue_drop_threshold,
      winback_stage2_days:        c.winback_stages.stage_2_days,
      winback_stage3_days:        c.winback_stages.stage_3_days,
      churn_risk_threshold:       c.winback_stages.stage_1_days,
      cart_recovery_delay_1h:     c.cart_recovery_delays.stage_1,
      cart_recovery_delay_4h:     c.cart_recovery_delays.stage_2,
      cart_recovery_delay_24h:    c.cart_recovery_delays.stage_3,
      feature_amazon:             c.features.amazon_pdp,
      feature_loyalty:            c.features.loyalty,
      feature_ugc:                c.features.ugc,
      feature_gamification:       c.features.gamification,
      feature_rag:                c.features.rag_support,
      feature_tax_reports:        c.features.tax_reports,
    };
  }

  /**
   * Returns config as a compact JSON string suitable for injecting
   * into n8n workflow variables via the Set node
   */
  toN8nVariable() {
    return JSON.stringify(this.config);
  }
}

module.exports = { BrandConfig, BRAND_CONFIG_DEFAULTS };
