/**
 * D2C AI Infrastructure — Credentials Registry
 *
 * Maps every n8n credential placeholder (YOUR_*_CREDENTIAL_ID)
 * to an environment variable. This file is the single source of truth
 * for what credentials are needed and where they're used.
 *
 * In n8n: set credentials.id and credentials.name via environment variables
 * rather than hardcoding IDs in workflow JSON files.
 */

'use strict';

const required = (name) => process.env[name] || null;

const optional = (name, fallback = null) => process.env[name] || fallback;

// ──────────────────────────────────────────────
// Credential registry
// ──────────────────────────────────────────────
const CREDENTIALS = {
  // ── AI ──────────────────────────────────────
  openai: {
    id:       optional('N8N_CRED_OPENAI_ID', 'openai-main'),
    name:     'OpenAI account',
    key:      required('OPENAI_API_KEY'),
    usedBy:   ['A-01', 'A-02', 'A-03', 'A-04', 'C-01', 'C-02', 'C-03', 'C-04',
               'I-01', 'I-02', 'I-03', 'R-01', 'R-02', 'R-04', 'S-01', 'S-02',
               'S-03', 'S-04', 'SC-01', 'SC-02', 'SC-03', 'SC-04'],
  },

  // ── DATABASE ─────────────────────────────────
  supabase: {
    id:       optional('N8N_CRED_SUPABASE_ID', 'supabase-main'),
    name:     'Supabase account',
    url:      required('SUPABASE_URL'),
    key:      required('SUPABASE_SERVICE_ROLE_KEY'),
    usedBy:   ['A-01', 'A-02', 'A-03', 'A-04', 'C-01', 'C-02', 'C-03', 'C-04',
               'I-01', 'I-02', 'I-03', 'I-04', 'R-01', 'R-02', 'R-03', 'R-04',
               'S-01', 'S-02', 'S-03', 'S-04', 'SC-01', 'SC-02', 'SC-03', 'SC-04'],
  },

  // ── VECTOR STORE ─────────────────────────────
  pinecone: {
    id:       optional('N8N_CRED_PINECONE_ID', 'pinecone-main'),
    name:     'Pinecone account',
    key:      optional('PINECONE_API_KEY'),
    index:    optional('PINECONE_INDEX_NAME', 'd2c-support-kb'),
    usedBy:   ['S-02'],
  },

  // ── E-COMMERCE ───────────────────────────────
  shopify: {
    id:       optional('N8N_CRED_SHOPIFY_ID', 'shopify-main'),
    name:     'Shopify account',
    domain:   required('SHOPIFY_SHOP_DOMAIN'),
    token:    required('SHOPIFY_ACCESS_TOKEN'),
    usedBy:   ['C-01', 'C-02', 'C-04', 'I-02', 'I-04', 'R-01', 'SC-02', 'SC-04'],
  },

  // ── EMAIL ────────────────────────────────────
  brevo: {
    id:       optional('N8N_CRED_BREVO_ID', 'brevo-main'),
    name:     'Brevo account',
    key:      required('BREVO_API_KEY'),
    fromEmail: required('BREVO_FROM_EMAIL'),
    fromName:  optional('BREVO_FROM_NAME', 'Your Brand'),
    usedBy:   ['A-02', 'C-01', 'C-02', 'R-01', 'R-02', 'R-04', 'SC-03'],
  },

  // SMTP (for system alert emails — no credential in n8n, uses sendEmail node)
  smtp: {
    id:       optional('N8N_CRED_SMTP_ID', 'smtp-main'),
    name:     'SMTP account',
    usedBy:   ['I-01', 'I-02', 'I-04', 'S-03'],  // AUDIT: these were missing credentials!
    note:     'Required for sendEmail nodes. Was missing in original workflows.',
  },

  // ── MESSAGING ────────────────────────────────
  whatsapp: {
    id:       optional('N8N_CRED_WHATSAPP_ID', 'whatsapp-main'),
    name:     'WhatsApp account',
    token:    required('WHATSAPP_ACCESS_TOKEN'),
    phoneId:  required('WHATSAPP_PHONE_NUMBER_ID'),
    usedBy:   ['A-03', 'R-02', 'S-01', 'S-04'],
    note:     'A-03 was incorrectly sending to IG user_id — must use IGSID for IG DMs',
  },

  // ── SOCIAL ───────────────────────────────────
  slack: {
    id:       optional('N8N_CRED_SLACK_ID', 'slack-main'),
    name:     'Slack account',
    token:    required('SLACK_BOT_TOKEN'),
    usedBy:   'all 24 workflows',
  },

  instagram: {
    id:       optional('N8N_CRED_INSTAGRAM_ID', 'instagram-main'),
    name:     'Instagram account',
    token:    required('INSTAGRAM_ACCESS_TOKEN'),
    accountId: optional('INSTAGRAM_BUSINESS_ACCOUNT_ID'),
    usedBy:   ['A-03', 'R-03', 'SC-01'],
    note:     'SC-01 DM permission requests need IGSID, not username',
  },

  meta_ads: {
    id:       optional('N8N_CRED_META_ID', 'meta-main'),
    name:     'Meta account',
    usedBy:   ['I-02'],
  },

  // ── ANALYTICS ────────────────────────────────
  google: {
    id:       optional('N8N_CRED_GOOGLE_ID', 'google-main'),
    name:     'Google account',
    usedBy:   ['I-02', 'I-04', 'SC-02'],
    services: ['Google Sheets', 'Google Analytics 4', 'Google My Business'],
  },
};

// ──────────────────────────────────────────────
// Validation — call during startup
// ──────────────────────────────────────────────
function validateCredentials() {
  const missing = [];
  const criticalEnvVars = [
    'OPENAI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SHOPIFY_SHOP_DOMAIN',
    'SHOPIFY_ACCESS_TOKEN',
    'BREVO_API_KEY',
    'BREVO_FROM_EMAIL',
    'SLACK_BOT_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'INSTAGRAM_ACCESS_TOKEN',
  ];

  criticalEnvVars.forEach((key) => {
    if (!process.env[key]) missing.push(key);
  });

  if (missing.length > 0) {
    console.error('[credentials] Missing required env vars:', missing.join(', '));
    return { valid: false, missing };
  }
  return { valid: true, missing: [] };
}

// ──────────────────────────────────────────────
// Generate n8n credential patch for a workflow
// Used by the onboarding API to replace YOUR_*_CREDENTIAL_ID
// ──────────────────────────────────────────────
function getCredentialPatch() {
  return {
    YOUR_OPENAI_CREDENTIAL_ID:    CREDENTIALS.openai.id,
    YOUR_SUPABASE_CREDENTIAL_ID:  CREDENTIALS.supabase.id,
    YOUR_SHOPIFY_CREDENTIAL_ID:   CREDENTIALS.shopify.id,
    YOUR_BREVO_CREDENTIAL_ID:     CREDENTIALS.brevo.id,
    YOUR_SLACK_CREDENTIAL_ID:     CREDENTIALS.slack.id,
    YOUR_WHATSAPP_CREDENTIAL_ID:  CREDENTIALS.whatsapp.id,
    YOUR_META_CREDENTIAL_ID:      CREDENTIALS.meta_ads.id,
    YOUR_GOOGLE_CREDENTIAL_ID:    CREDENTIALS.google.id,
    YOUR_PINECONE_CREDENTIAL_ID:  CREDENTIALS.pinecone.id,
  };
}

module.exports = { CREDENTIALS, validateCredentials, getCredentialPatch };
