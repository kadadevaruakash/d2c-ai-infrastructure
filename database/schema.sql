-- ============================================================
-- D2C AI Infrastructure — Supabase Schema
-- Multi-tenant white-label architecture
-- Every table has tenant_id for full data isolation
-- ============================================================

-- =====================
-- EXTENSIONS
-- =====================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================
-- TENANTS (White-label clients)
-- =====================
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug          TEXT UNIQUE NOT NULL,            -- e.g. 'brandname' (used in webhook paths)
  name          TEXT NOT NULL,                   -- e.g. 'Brand Name Inc'
  plan          TEXT NOT NULL DEFAULT 'starter', -- starter | growth | enterprise
  status        TEXT NOT NULL DEFAULT 'active',  -- active | suspended | trial
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================
-- TENANT CONFIGURATION (Brand + Channel settings)
-- This is the core of white-labeling
-- =====================
CREATE TABLE tenant_config (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Brand
  brand_name                TEXT NOT NULL DEFAULT 'Your Brand',
  brand_voice               TEXT DEFAULT 'professional yet approachable',
  store_url                 TEXT DEFAULT 'https://yourstore.com',
  calendly_url              TEXT DEFAULT 'https://calendly.com/yourname/15min',
  logo_url                  TEXT,
  primary_color             TEXT DEFAULT '#000000',
  -- Contact routing
  strategy_email            TEXT DEFAULT 'strategy@yourcompany.com',
  ops_email                 TEXT DEFAULT 'ops@yourcompany.com',
  finance_email             TEXT DEFAULT 'finance@yourcompany.com',
  support_email             TEXT DEFAULT 'support@yourcompany.com',
  manager_email             TEXT DEFAULT 'manager@yourcompany.com',
  ceo_phone                 TEXT,
  -- Slack channels
  slack_channel_leads       TEXT DEFAULT '#leads',
  slack_channel_outreach    TEXT DEFAULT '#outreach',
  slack_channel_hot_leads   TEXT DEFAULT '#hot-leads',
  slack_channel_content     TEXT DEFAULT '#content-team',
  slack_channel_amazon      TEXT DEFAULT '#amazon-ops',
  slack_channel_launches    TEXT DEFAULT '#product-launches',
  slack_channel_analytics   TEXT DEFAULT '#analytics',
  slack_channel_revenue     TEXT DEFAULT '#daily-revenue',
  slack_channel_crm         TEXT DEFAULT '#crm-updates',
  slack_channel_retention   TEXT DEFAULT '#retention',
  slack_channel_support     TEXT DEFAULT '#support-escalations',
  slack_channel_reviews     TEXT DEFAULT '#reviews',
  slack_channel_social      TEXT DEFAULT '#social-media',
  slack_channel_ugc         TEXT DEFAULT '#ugc-team',
  slack_channel_incidents   TEXT DEFAULT '#incidents',
  slack_channel_seo         TEXT DEFAULT '#seo-updates',
  slack_channel_sales       TEXT DEFAULT '#sales-alerts',
  slack_channel_checkout    TEXT DEFAULT '#checkout-analytics',
  -- Commerce
  free_shipping_threshold   NUMERIC(10,2) DEFAULT 75.00,
  default_currency          TEXT DEFAULT 'USD',
  -- AI
  ai_model_standard         TEXT DEFAULT 'gpt-4o-mini',
  ai_model_premium          TEXT DEFAULT 'gpt-4o',           -- used for CEO assistant, blog posts
  -- Thresholds
  lead_hot_score_threshold  INT DEFAULT 70,
  cart_recovery_delay_1h    INT DEFAULT 60,   -- minutes
  cart_recovery_delay_4h    INT DEFAULT 240,
  cart_recovery_delay_24h   INT DEFAULT 1440,
  winback_stage2_days       INT DEFAULT 90,
  winback_stage3_days       INT DEFAULT 120,
  churn_risk_threshold      INT DEFAULT 60,   -- days since last order to flag
  roas_alert_threshold      NUMERIC(4,2) DEFAULT 2.00,
  margin_alert_threshold    NUMERIC(5,2) DEFAULT 30.00,
  revenue_drop_threshold    NUMERIC(5,2) DEFAULT 20.00,  -- % drop to alert
  -- Feature flags
  feature_amazon            BOOLEAN DEFAULT FALSE,
  feature_loyalty           BOOLEAN DEFAULT TRUE,
  feature_ugc               BOOLEAN DEFAULT TRUE,
  feature_gamification      BOOLEAN DEFAULT TRUE,
  feature_rag               BOOLEAN DEFAULT TRUE,
  feature_tax_reports       BOOLEAN DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id)
);

-- =====================
-- ACQUISITION PILLAR (A)
-- =====================

-- A-01: Leads
CREATE TABLE leads (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id       TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  company       TEXT,
  score         INT DEFAULT 0,
  category      TEXT DEFAULT 'cold',    -- hot | warm | cold
  priority      TEXT DEFAULT 'medium',  -- high | medium | low
  source        TEXT DEFAULT 'direct',
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  budget_range  TEXT DEFAULT 'unknown',
  niche         TEXT DEFAULT 'unknown',
  urgency       TEXT DEFAULT 'medium',
  next_action   TEXT,
  qualified     BOOLEAN DEFAULT FALSE,
  status        TEXT DEFAULT 'new',     -- new | contacted | qualified | disqualified
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_tenant ON leads(tenant_id);
CREATE INDEX idx_leads_category ON leads(tenant_id, category);
CREATE INDEX idx_leads_email ON leads(tenant_id, email);

-- A-02: Prospects (cold outreach targets)
CREATE TABLE prospects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  title           TEXT,
  company         TEXT,
  industry        TEXT,
  recent_activity TEXT,
  pain_points     TEXT,
  email_sent      BOOLEAN DEFAULT FALSE,
  sent_at         TIMESTAMPTZ,
  email_subject   TEXT,
  status          TEXT DEFAULT 'active',  -- active | paused | bounced | unsubscribed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_prospects_tenant ON prospects(tenant_id);
CREATE INDEX idx_prospects_unsent ON prospects(tenant_id, email_sent, status);

-- A-03: Instagram Interactions
CREATE TABLE ig_interactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username          TEXT NOT NULL,
  user_igsid        TEXT,               -- Instagram-Scoped User ID (required for DMs)
  dm_text           TEXT,
  intent_score      INT DEFAULT 0,
  product_linked    BOOLEAN DEFAULT FALSE,
  calendly_offered  BOOLEAN DEFAULT FALSE,
  booking_url       TEXT,
  post_id           TEXT,
  event_type        TEXT DEFAULT 'comment',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ig_tenant ON ig_interactions(tenant_id);

-- A-04: SEO Keywords + Blog Posts
CREATE TABLE content_keywords (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  keyword       TEXT NOT NULL,
  volume        INT DEFAULT 0,
  difficulty    INT DEFAULT 0,
  status        TEXT DEFAULT 'pending',  -- pending | in_progress | completed
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, keyword)
);

CREATE TABLE blog_posts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  content          TEXT,
  meta_description TEXT,
  keyword          TEXT,
  word_count       INT DEFAULT 0,
  status           TEXT DEFAULT 'draft',  -- draft | review | published
  published_url    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_blog_tenant ON blog_posts(tenant_id);

-- =====================
-- CONVERSION PILLAR (C)
-- =====================

-- C-01: Cart Recoveries
CREATE TABLE cart_recoveries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recovery_id     TEXT UNIQUE NOT NULL,
  checkout_id     TEXT NOT NULL,
  customer_email  TEXT,
  customer_phone  TEXT,
  cart_value      NUMERIC(10,2) DEFAULT 0,
  items           JSONB DEFAULT '[]',
  channel         TEXT DEFAULT 'email',   -- email | sms | whatsapp
  scheduled_time  TIMESTAMPTZ NOT NULL,
  incentive       TEXT DEFAULT 'none',    -- none | 5% | 10% | free_shipping
  tone            TEXT DEFAULT 'friendly',
  status          TEXT DEFAULT 'scheduled', -- scheduled | sent | recovered | expired
  sent_at         TIMESTAMPTZ,
  recovered_at    TIMESTAMPTZ,
  recovery_value  NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cart_recovery_tenant ON cart_recoveries(tenant_id);
CREATE INDEX idx_cart_recovery_due ON cart_recoveries(tenant_id, status, scheduled_time);

-- C-02: Product Waitlist
CREATE TABLE product_waitlist (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  notified    BOOLEAN DEFAULT FALSE,
  notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, product_id, email)
);

CREATE TABLE inventory_notifications (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_id  TEXT UNIQUE NOT NULL,
  product_id       TEXT NOT NULL,
  product_name     TEXT,
  vip_sent         INT DEFAULT 0,
  waitlist_sent    INT DEFAULT 0,
  general_sent     INT DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- C-03: Amazon Listings
CREATE TABLE amazon_listings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asin              TEXT NOT NULL,
  current_title     TEXT,
  current_bullets   TEXT,
  search_terms      TEXT,
  competitor_titles TEXT,
  conversion_rate   NUMERIC(5,2) DEFAULT 0,
  status            TEXT DEFAULT 'active',
  last_optimized_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, asin)
);

CREATE TABLE listing_optimizations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  optimization_id   TEXT UNIQUE NOT NULL,
  asin              TEXT NOT NULL,
  new_title         TEXT,
  new_bullets       JSONB DEFAULT '[]',
  backend_keywords  TEXT,
  confidence_score  NUMERIC(3,2) DEFAULT 0,
  status            TEXT DEFAULT 'pending_approval', -- pending_approval | approved | applied | rejected
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- C-04: Checkout Gamification
CREATE TABLE checkout_gamification (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  checkout_id       TEXT NOT NULL,
  gamification_type TEXT,               -- spin_wheel | progress_bar | mystery_box
  discount_code     TEXT,
  discount_value    TEXT,               -- 5% | 10% | 15% | free_shipping
  shopify_price_rule_id TEXT,           -- ID of actual Shopify price rule (required!)
  engagement_score  INT DEFAULT 0,
  code_used         BOOLEAN DEFAULT FALSE,
  status            TEXT DEFAULT 'active', -- active | used | expired
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, checkout_id)
);

-- =====================
-- INTELLIGENCE PILLAR (I)
-- =====================

-- I-01: Competitors
CREATE TABLE competitors (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  website_url  TEXT NOT NULL,
  category     TEXT,
  status       TEXT DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE competitor_alerts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_id           TEXT UNIQUE NOT NULL,
  competitor_id      UUID REFERENCES competitors(id),
  changes            JSONB DEFAULT '[]',
  implication        TEXT,
  threat_level       TEXT DEFAULT 'low',   -- low | medium | high
  recommended_action TEXT,
  timeline           TEXT,
  actioned           BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comp_alerts_tenant ON competitor_alerts(tenant_id, threat_level);

-- I-02: Daily Revenue Reports
CREATE TABLE daily_reports (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_date      DATE NOT NULL,
  revenue          NUMERIC(12,2) DEFAULT 0,
  orders           INT DEFAULT 0,
  aov              NUMERIC(10,2) DEFAULT 0,
  refunds          INT DEFAULT 0,
  refund_amount    NUMERIC(10,2) DEFAULT 0,
  ad_spend         NUMERIC(10,2) DEFAULT 0,
  roas             NUMERIC(5,2) DEFAULT 0,
  revenue_change   NUMERIC(6,2) DEFAULT 0,  -- % vs previous day
  gross_margin     NUMERIC(5,2) DEFAULT 0,  -- Note: this is contribution margin (revenue - ad_spend)
  has_anomalies    BOOLEAN DEFAULT FALSE,
  anomalies        JSONB DEFAULT '[]',
  alert_level      TEXT DEFAULT 'normal',   -- normal | warning | critical
  ai_analysis      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, report_date)
);

CREATE INDEX idx_daily_reports_tenant ON daily_reports(tenant_id, report_date DESC);

-- I-03: Customer Intelligence
CREATE TABLE customer_interactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     TEXT NOT NULL,
  interaction_type TEXT DEFAULT 'general',
  channel         TEXT DEFAULT 'web',
  intent          TEXT DEFAULT 'unknown',
  sentiment       TEXT DEFAULT 'neutral', -- positive | neutral | negative
  message         TEXT,
  product_interest JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cust_interactions_tenant ON customer_interactions(tenant_id, customer_id);

CREATE TABLE customer_intelligence (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id         TEXT NOT NULL,
  segment             TEXT,
  product_affinity    JSONB DEFAULT '[]',
  churn_risk_score    INT DEFAULT 0,         -- 0-100
  sentiment_trend     TEXT DEFAULT 'stable', -- improving | stable | declining
  ltv_prediction      NUMERIC(12,2) DEFAULT 0,
  upsell_opportunities JSONB DEFAULT '[]',
  recommendations     JSONB DEFAULT '[]',
  confidence          NUMERIC(3,2) DEFAULT 0.5,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, customer_id)
);

-- I-04: Tax Reports
CREATE TABLE tax_reports (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period               TEXT NOT NULL,         -- YYYY-MM
  total_revenue        NUMERIC(12,2) DEFAULT 0,
  total_orders         INT DEFAULT 0,
  total_estimated_tax  NUMERIC(10,2) DEFAULT 0,
  jurisdictions        JSONB DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, period)
);

-- =====================
-- RETENTION PILLAR (R)
-- =====================

-- Core customer table (used across multiple pillars)
CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopify_id        TEXT,
  email             TEXT NOT NULL,
  name              TEXT,
  phone             TEXT,
  -- CRM fields
  segment           TEXT DEFAULT 'New',    -- Champion | Loyal | Potential | New | At Risk | Lost
  lifecycle_stage   TEXT DEFAULT 'new',   -- new | potential | loyal | champion
  tags              JSONB DEFAULT '[]',
  rfm_r             INT DEFAULT 3,
  rfm_f             INT DEFAULT 3,
  rfm_m             INT DEFAULT 3,
  -- Order history
  order_count       INT DEFAULT 0,
  lifetime_value    NUMERIC(12,2) DEFAULT 0,
  last_order_date   DATE,
  days_since_order  INT DEFAULT 0,
  -- Loyalty
  vip_tier          TEXT DEFAULT 'regular', -- regular | bronze | silver | gold | platinum
  -- Winback
  winback_sent      BOOLEAN DEFAULT FALSE,
  winback_stage     INT DEFAULT 0,
  winback_sent_at   TIMESTAMPTZ,
  -- CRM next action
  next_touchpoint   TIMESTAMPTZ,
  recommended_campaign TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_customers_segment ON customers(tenant_id, segment);
CREATE INDEX idx_customers_winback ON customers(tenant_id, winback_sent, last_order_date);
CREATE INDEX idx_customers_phone ON customers(tenant_id, phone);

-- R-02: Loyalty Program
CREATE TABLE loyalty_accounts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  points_balance  INT DEFAULT 0,
  lifetime_points INT DEFAULT 0,
  tier            TEXT DEFAULT 'bronze',  -- bronze | silver | gold | platinum
  tier_discount   INT DEFAULT 0,         -- percent
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, customer_id)
);

CREATE TABLE loyalty_transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,  -- purchase | referral | review | social_share | birthday | redemption
  points        INT NOT NULL,
  balance_after INT NOT NULL,
  reference_id  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_loyalty_txn_tenant ON loyalty_transactions(tenant_id, customer_id);

-- R-03: Content Calendar
CREATE TABLE content_calendar (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  post_type       TEXT DEFAULT 'product',
  topic           TEXT,
  product_name    TEXT,
  campaign        TEXT,
  voice_description TEXT,
  media_url       TEXT,
  platform        TEXT DEFAULT 'instagram',
  scheduled_date  TIMESTAMPTZ,
  status          TEXT DEFAULT 'scheduled', -- scheduled | published | failed | cancelled
  published_at    TIMESTAMPTZ,
  final_caption   TEXT,
  instagram_post_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_content_cal_tenant ON content_calendar(tenant_id, status, scheduled_date);

-- R-04: Winback Campaigns
CREATE TABLE winback_campaigns (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  winback_id             TEXT UNIQUE NOT NULL,
  customer_id            UUID REFERENCES customers(id),
  stage                  INT DEFAULT 1,  -- 1 | 2 | 3
  churn_risk_score       INT DEFAULT 0,
  incentive              TEXT DEFAULT 'personal note',
  expected_response_rate NUMERIC(5,4) DEFAULT 0,
  email_sent             BOOLEAN DEFAULT FALSE,
  responded              BOOLEAN DEFAULT FALSE,
  converted              BOOLEAN DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================
-- SUPPORT PILLAR (S)
-- =====================

-- S-01 / S-02: Support interactions
CREATE TABLE support_tickets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id       TEXT UNIQUE NOT NULL,
  customer_phone  TEXT,
  customer_email  TEXT,
  customer_id     UUID REFERENCES customers(id),
  channel         TEXT DEFAULT 'whatsapp',
  intent          TEXT,
  status          TEXT DEFAULT 'open',   -- open | resolved | escalated | closed
  escalated       BOOLEAN DEFAULT FALSE,
  escalation_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE TABLE support_interactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id       UUID REFERENCES support_tickets(id),
  message_id      TEXT,
  customer_phone  TEXT,
  intent          TEXT,
  message         TEXT,
  response        TEXT,
  escalated       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_support_interactions_tenant ON support_interactions(tenant_id, customer_phone);

-- S-02: RAG interactions
CREATE TABLE rag_interactions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  answer_id            TEXT UNIQUE NOT NULL,
  query                TEXT NOT NULL,
  answer               TEXT,
  confidence_score     NUMERIC(3,2) DEFAULT 0,
  sources              JSONB DEFAULT '[]',
  escalated            BOOLEAN DEFAULT FALSE,
  retrieval_time_ms    INT,
  customer_id          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- S-03: Review Alerts
CREATE TABLE review_alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_id        TEXT UNIQUE NOT NULL,
  review_id       TEXT NOT NULL,
  platform        TEXT DEFAULT 'google',
  rating          INT,
  reviewer_name   TEXT,
  review_text     TEXT,
  sentiment       TEXT,
  urgency         TEXT DEFAULT 'low',  -- low | medium | high | critical
  response_draft  TEXT,
  response_posted BOOLEAN DEFAULT FALSE,
  action_required TEXT,
  escalated_to    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, review_id)           -- prevent duplicate alerts
);

CREATE INDEX idx_review_alerts_tenant ON review_alerts(tenant_id, urgency);

-- S-04: Incident Alerts
CREATE TABLE incident_alerts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_id           TEXT UNIQUE NOT NULL,
  audit_log_id       TEXT UNIQUE NOT NULL,
  incident_type      TEXT,
  severity           TEXT DEFAULT 'medium',  -- low | medium | high | critical
  summary            TEXT,
  key_facts          JSONB DEFAULT '[]',
  action_options     JSONB DEFAULT '[]',
  recommended_action TEXT,
  ceo_response       TEXT,     -- '1' | '2' | '3' — from WhatsApp reply
  resolved           BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE team_availability (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  role        TEXT,
  status      TEXT DEFAULT 'available',  -- available | busy | offline
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================
-- SCALE PILLAR (SC)
-- =====================

-- SC-01: UGC Library
CREATE TABLE ugc_library (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ugc_id            TEXT UNIQUE NOT NULL,
  post_id           TEXT NOT NULL,
  platform          TEXT DEFAULT 'instagram',
  creator_handle    TEXT,
  creator_igsid     TEXT,               -- IGSID for DM capability
  media_url         TEXT,
  permalink         TEXT,
  caption           TEXT,
  media_type        TEXT,               -- IMAGE | VIDEO | CAROUSEL_ALBUM
  quality_score     INT DEFAULT 0,
  brand_aligned     BOOLEAN DEFAULT TRUE,
  permission_status TEXT DEFAULT 'requested',  -- requested | granted | denied | pending
  permission_message TEXT,
  suggested_use     TEXT DEFAULT 'social',     -- social | ads | website
  priority          TEXT DEFAULT 'medium',
  tags              JSONB DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, post_id)
);

-- SC-02: Funnel Analytics
CREATE TABLE funnel_analytics (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_date            DATE NOT NULL,
  sessions               INT DEFAULT 0,
  page_views             INT DEFAULT 0,
  add_to_carts           INT DEFAULT 0,
  checkouts              INT DEFAULT 0,
  purchases              INT DEFAULT 0,
  overall_conversion_rate NUMERIC(5,2) DEFAULT 0,
  dropoff_points         JSONB DEFAULT '[]',
  revenue_by_channel     JSONB DEFAULT '{}',
  ai_analysis            TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, report_date)
);

-- SC-03: Sales Automation
CREATE TABLE sales_automation (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id       TEXT UNIQUE NOT NULL,
  customer_id         UUID REFERENCES customers(id),
  intent_level        TEXT DEFAULT 'low',   -- high | medium | low
  signal_type         TEXT DEFAULT 'chat',
  next_action         TEXT,
  follow_up_sequence  JSONB DEFAULT '{}',
  priority            TEXT DEFAULT 'medium',
  calendly_booked     BOOLEAN DEFAULT FALSE,
  status              TEXT DEFAULT 'active', -- active | completed | expired
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SC-04: SEO Meta Tags
CREATE TABLE seo_meta_tags (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL,
  title_tag        TEXT,
  meta_description TEXT,
  og_title         TEXT,
  og_description   TEXT,
  keywords         JSONB DEFAULT '[]',
  structured_data_type TEXT DEFAULT 'Product',
  status           TEXT DEFAULT 'pending',   -- pending | applied | rejected
  applied_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, product_id)
);

-- =====================
-- ROW-LEVEL SECURITY (RLS)
-- Ensures each tenant can only see their own data
-- =====================
ALTER TABLE tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ig_interactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_keywords     ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_recoveries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_waitlist     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_listings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_optimizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_gamification ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_alerts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_reports          ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_calendar     ENABLE ROW LEVEL SECURITY;
ALTER TABLE winback_campaigns    ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_interactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_alerts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_alerts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_availability    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ugc_library          ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_analytics     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_automation     ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_meta_tags        ENABLE ROW LEVEL SECURITY;

-- RLS policy template (apply for each table):
-- CREATE POLICY tenant_isolation ON <table>
--   USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- =====================
-- UPDATED_AT TRIGGER
-- =====================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated    BEFORE UPDATE ON tenants    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_config_updated     BEFORE UPDATE ON tenant_config FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customers_updated  BEFORE UPDATE ON customers  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =====================
-- USER → TENANT MAPPING
-- Links Supabase Auth users to tenants (supports multi-user teams per tenant)
-- =====================
CREATE TABLE user_tenants (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'owner',  -- owner | admin | member
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX idx_user_tenants_user   ON user_tenants(user_id);
CREATE INDEX idx_user_tenants_tenant ON user_tenants(tenant_id);
ALTER TABLE user_tenants ENABLE ROW LEVEL SECURITY;

-- =====================
-- WORKFLOW STATES
-- Tracks which of the 24 workflows are enabled per tenant,
-- plus per-tenant config overrides and run metadata.
-- =====================
CREATE TABLE workflow_states (
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id      TEXT NOT NULL,              -- e.g. 'a01', 'c04', 'sc02'
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  config_overrides JSONB NOT NULL DEFAULT '{}', -- per-workflow settings (thresholds, channels, etc.)
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,                        -- success | error | running
  run_count        INT NOT NULL DEFAULT 0,
  error_count      INT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, workflow_id)
);

CREATE INDEX idx_workflow_states_tenant ON workflow_states(tenant_id);
ALTER TABLE workflow_states ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_workflow_states_updated
  BEFORE UPDATE ON workflow_states
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
