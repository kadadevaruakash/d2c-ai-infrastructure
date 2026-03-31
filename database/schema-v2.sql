-- ============================================================
-- D2C AI Infrastructure — Schema v2 additions
-- Run AFTER schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_execution_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'completed',
  duration_ms     INT,
  input_summary   TEXT,
  output_summary  TEXT,
  error_message   TEXT,
  input_payload   JSONB,
  output_payload  JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exec_logs_tenant   ON workflow_execution_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_logs_workflow ON workflow_execution_logs(tenant_id, workflow_id);

CREATE TABLE IF NOT EXISTS revenue_attribution (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id   TEXT NOT NULL,
  order_id      TEXT,
  revenue       NUMERIC(10,2) NOT NULL,
  currency      TEXT DEFAULT 'GBP',
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revenue_attr ON revenue_attribution(tenant_id, workflow_id);

CREATE TABLE IF NOT EXISTS email_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id     TEXT,
  message_id      TEXT,
  event_type      TEXT NOT NULL,
  recipient_email TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_events ON email_events(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ab_tests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  variant_a   TEXT NOT NULL,
  variant_b   TEXT NOT NULL,
  a_sent      INT DEFAULT 0,
  a_opened    INT DEFAULT 0,
  b_sent      INT DEFAULT 0,
  b_opened    INT DEFAULT 0,
  winner      TEXT,
  status      TEXT DEFAULT 'running',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ab_tests ON ab_tests(tenant_id);

CREATE TABLE IF NOT EXISTS content_items (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'blog',
  platform         TEXT DEFAULT 'Website',
  status           TEXT DEFAULT 'draft',
  content          TEXT,
  meta_description TEXT,
  keyword          TEXT,
  scheduled_at     TIMESTAMPTZ,
  published_at     TIMESTAMPTZ,
  source_workflow  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_items ON content_items(tenant_id, status);

CREATE TABLE IF NOT EXISTS rag_documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  size_bytes   BIGINT DEFAULT 0,
  chunk_count  INT DEFAULT 0,
  pinecone_ids JSONB,
  status       TEXT DEFAULT 'processing',
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rag_docs ON rag_documents(tenant_id);

CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  plan                   TEXT NOT NULL DEFAULT 'growth',
  status                 TEXT NOT NULL DEFAULT 'active',
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id)
);

CREATE TABLE IF NOT EXISTS agency_accounts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  api_key_hash TEXT NOT NULL,
  plan         TEXT DEFAULT 'agency',
  status       TEXT DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agency_tenants (
  agency_id UUID NOT NULL REFERENCES agency_accounts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agency_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS client_portal_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label      TEXT DEFAULT 'Dashboard access',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_tokens ON client_portal_tokens(tenant_id);
