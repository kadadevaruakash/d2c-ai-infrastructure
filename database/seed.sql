-- ============================================================
-- D2C AI Infrastructure — Seed Data
-- Creates a demo tenant with default configuration
-- Run after schema.sql
-- ============================================================

-- Create demo tenant
INSERT INTO tenants (id, slug, name, plan, status)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'demo-brand',
  'Demo D2C Brand',
  'growth',
  'active'
);

-- Populate default config for demo tenant
-- All values here are overridden per real client during onboarding
INSERT INTO tenant_config (tenant_id, brand_name, store_url, brand_voice)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Demo Brand',
  'https://demo.yourstore.com',
  'Friendly, direct, and customer-first'
);

-- Seed competitors for demo
INSERT INTO competitors (tenant_id, name, website_url, category)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Competitor Alpha', 'https://competitoralpha.com', 'direct'),
  ('a0000000-0000-0000-0000-000000000001', 'Competitor Beta',  'https://competitorbeta.com',  'indirect');

-- Seed team availability
INSERT INTO team_availability (tenant_id, member_name, role, status)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Alice', 'Support Lead', 'available'),
  ('a0000000-0000-0000-0000-000000000001', 'Bob',   'Operations',   'available');

-- Seed content keywords
INSERT INTO content_keywords (tenant_id, keyword, volume, difficulty, status)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'best d2c skincare routine', 4400, 35, 'pending'),
  ('a0000000-0000-0000-0000-000000000001', 'how to choose face serum',  2900, 28, 'pending');
