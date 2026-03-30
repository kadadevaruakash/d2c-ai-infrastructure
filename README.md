# D2C AI Infrastructure

Plug-and-play AI backend for D2C organisations.
24 n8n workflows covering the full customer lifecycle, with multi-tenant white-labeling and a shared service layer.

---

## Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                        D2C AI INFRASTRUCTURE                         │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│  │  ACQUIRE   │  │  CONVERT   │  │ INTELLIGENCE│  │   RETAIN   │    │
│  │  (A-01–04) │  │  (C-01–04) │  │  (I-01–04) │  │  (R-01–04) │    │
│  │            │  │            │  │            │  │            │    │
│  │Lead Capture│  │Cart Recover│  │Competitor  │  │CRM + RFM   │    │
│  │Cold Email  │  │Inventory   │  │Revenue     │  │Loyalty     │    │
│  │IG DM Bot   │  │Amazon PDP  │  │Cust Intel  │  │Social Auto │    │
│  │SEO Content │  │Gamif. CKO  │  │Tax Reports │  │Winback     │    │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘    │
│                                                                      │
│  ┌────────────┐  ┌────────────┐                                     │
│  │  SUPPORT   │  │   SCALE    │                                     │
│  │  (S-01–04) │  │  (SC-01–04)│                                     │
│  │            │  │            │                                     │
│  │WA Support  │  │UGC Collect │                                     │
│  │RAG Brain   │  │Funnel Anal │                                     │
│  │Review Alert│  │Sales Auto  │                                     │
│  │CEO Assist  │  │SEO Meta    │                                     │
│  └────────────┘  └────────────┘                                     │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   SHARED SERVICE LAYER                       │   │
│  │  AI Client  │  Notification  │  Customer  │  Email Utility   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                        API SERVER                            │   │
│  │  /api/onboard  │  /api/config/:slug  │  /api/health  │ notify│  │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                       SUPABASE (DB)                          │   │
│  │  tenants · tenant_config · customers · leads · prospects     │   │
│  │  loyalty · cart_recoveries · content_calendar · winback      │   │
│  │  reviews · rag_interactions · sales_automation · ugc · ...   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Workflow orchestration | n8n (self-hosted or cloud) |
| Database | Supabase (Postgres + RLS) |
| AI | OpenAI GPT-4o-mini (standard) · GPT-4o (premium) |
| Vector store | Pinecone (RAG support brain) |
| E-commerce | Shopify |
| Email | Brevo (Sendinblue) |
| Messaging | WhatsApp Business Cloud API |
| Notifications | Slack |
| Analytics | Google Analytics 4 · Google Sheets |
| Social | Instagram Graph API |
| Ads | Meta Ads API |
| Backend API | Node.js + Express |

---

## Repository Structure

```
d2c-ai-infrastructure/
├── api/
│   ├── server.js         # Express API server
│   ├── onboarding.js     # Tenant provisioning
│   └── health.js         # Health check endpoints
│
├── config/
│   ├── brand.config.js   # White-label brand configuration
│   ├── credentials.config.js  # Credentials registry
│   └── .env.example      # Environment variable template
│
├── database/
│   ├── schema.sql        # Full Supabase schema (34 tables, RLS)
│   └── seed.sql          # Demo tenant seed data
│
├── shared/
│   ├── ai-client.js      # AI call utility + JSON parser
│   ├── notification.js   # Centralized Slack notifier
│   ├── customer.js       # Customer context utility
│   └── email.js          # Brevo email utility
│
├── workflows/            # Fixed n8n workflow JSONs (post-audit)
│   ├── acquire/          # A-01 to A-04
│   ├── convert/          # C-01 to C-04
│   ├── intelligence/     # I-01 to I-04
│   ├── retain/           # R-01 to R-04
│   ├── support/          # S-01 to S-04
│   └── scale/            # SC-01 to SC-04
│
└── docs/
    └── AUDIT_REPORT.md   # Full 24-workflow audit findings
```

---

## Setup Guide

### Prerequisites
- n8n instance (self-hosted recommended: `docker-compose` or Railway)
- Supabase project (free tier works for up to ~2 clients)
- Node.js 18+

### Step 1 — Environment
```bash
cp config/.env.example .env
# Fill in all required values (see .env.example for descriptions)
```

### Step 2 — Database
```bash
# In Supabase SQL editor, run in order:
# 1. database/schema.sql
# 2. database/seed.sql    (optional — creates demo tenant)
```

### Step 3 — Start API Server
```bash
npm install
node api/server.js
```

### Step 4 — Onboard a Client

```bash
curl -X POST http://localhost:3000/api/onboard \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_SECRET_KEY" \
  -d '{
    "tenantSlug": "client-brand",
    "tenantName": "Client Brand Inc",
    "plan": "growth",
    "brand": {
      "brand_name": "Client Brand",
      "store_url": "https://clientbrand.com",
      "calendly_url": "https://calendly.com/clientbrand/15min",
      "strategy_email": "team@clientbrand.com",
      "ops_email": "ops@clientbrand.com",
      "finance_email": "finance@clientbrand.com",
      "ceo_phone": "+15551234567",
      "free_shipping_threshold": 99,
      "slack_channels": {
        "leads": "#client-leads",
        "revenue": "#client-revenue"
      },
      "features": {
        "amazon_pdp": false,
        "loyalty": true
      }
    }
  }'
```

The API will:
1. Create the tenant in Supabase
2. Inject all brand values into the 24 workflows
3. Replace all `YOUR_*_CREDENTIAL_ID` placeholders
4. Import workflows into n8n via API
5. Return unique webhook URLs per workflow

### Step 5 — Configure Shopify Webhooks
Point Shopify webhook events to the returned URLs:
- `checkout/create` → cart recovery URL
- `orders/create` → CRM follow-up URL
- `products/create` → SEO meta URL
- `inventory_levels/update` → inventory drop URL

---

## Audit Summary

7 critical bugs found and documented. See [docs/AUDIT_REPORT.md](docs/AUDIT_REPORT.md).

**Top 3 to fix before any client goes live:**
1. **A-03** — Instagram DM sends to wrong API (WhatsApp instead of IG)
2. **C-04** — Discount codes are generated but never created in Shopify
3. **S-03** — Google review star ratings parsed incorrectly (always returns NaN)

---

## White-Labeling Model

```
Each client (tenant) gets:
  ✓ Isolated Supabase data (Row Level Security)
  ✓ Their own brand values in all 24 workflows
  ✓ Unique webhook paths  (e.g. /webhook/a01-lead-capture-mybrand)
  ✓ Their own Slack channels, email addresses, store URL
  ✓ Feature flags (enable/disable Amazon, Loyalty, etc.)
  ✓ Custom AI model selection per tier
  ✓ Custom thresholds (cart value, churn days, ROAS alerts)

What's shared across clients (single n8n instance model):
  • OpenAI API key (cost allocation by tenant_id possible via tagging)
  • Supabase project (partitioned by tenant_id)
  • Slack workspace (different channels per client)

For full isolation (enterprise clients):
  • Separate n8n instance per client
  • Separate Supabase project per client
  • Run onboarding API pointing to client-specific n8n
```

---

## API Keys Required

| Service | Used By | Required? |
|---------|---------|-----------|
| OpenAI API | All 24 workflows | Yes |
| Supabase URL + Key | All 24 workflows | Yes |
| Shopify Access Token | C-01, C-02, C-04, I-02, I-04, R-01, SC-02, SC-04 | Yes |
| Brevo API Key | A-02, C-01, C-02, R-01, R-02, R-04, SC-03 | Yes |
| Slack Bot Token | All 24 workflows | Yes |
| WhatsApp Business Token | A-03, R-02, S-01, S-04 | Yes |
| Instagram Access Token | A-03, R-03, SC-01 | Yes |
| Pinecone API Key | S-02 | Yes (for RAG) |
| Google (Sheets + GA4) | I-02, I-04, SC-02 | Yes |
| Meta Ads API | I-02 | Optional |
| SMTP (for alert emails) | I-01, I-02, I-04, S-03 | Yes (was missing) |

---

## Key Questions Before Full Deployment

Before deploying for a client, confirm:

1. **Multi-tenancy model** — Single shared n8n instance or separate per client?
2. **AI provider** — Keep OpenAI or switch/add Claude (Anthropic) for cost or quality?
3. **CEO assistant reply handling** — S-04 sends WhatsApp with "Reply 1/2/3" but no handler workflow exists yet for parsing the reply. Build needed.
4. **Shopify discount creation** — C-04 gamification needs Shopify price rule creation added.
5. **IG DM routing** — A-03 needs either ManyChat integration or native Instagram Messaging API (requires app review by Meta).
6. **Knowledge base** — S-02 RAG brain needs product/policy documents uploaded to Pinecone before it can answer anything.

---

## License

Internal use only. Not for distribution without authorization.
