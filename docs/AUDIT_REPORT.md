# D2C AI Infrastructure — Full Audit Report

**Date:** 2026-03-30
**Workflows Audited:** 24 (A-01 to SC-04)
**Stack:** n8n · Supabase · OpenAI · Shopify · Brevo · Slack · WhatsApp Business · Pinecone · Google Analytics 4 · Google Sheets

---

## 1. Architecture Overview

The 24 workflows are organized into 6 pillars:

| Pillar | Code | Workflows | Trigger Type |
|--------|------|-----------|--------------|
| Acquisition | A | A-01 Lead Capture, A-02 Cold Email, A-03 IG DM, A-04 SEO Content | Webhook (A-01, A-03) + Scheduled (A-02, A-04) |
| Conversion | C | C-01 Cart Recovery, C-02 Inventory Drop, C-03 Amazon PDP, C-04 Gamified Checkout | Shopify trigger (C-01, C-02, C-04) + Scheduled (C-03) |
| Intelligence | I | I-01 Competitor Tracker, I-02 Revenue Reports, I-03 Customer Intel, I-04 Tax Compliance | Scheduled (I-01, I-02, I-04) + Webhook (I-03) |
| Retention | R | R-01 CRM Follow-up, R-02 Loyalty Engine, R-03 Social Auto, R-04 Winback | Shopify trigger (R-01) + Webhook (R-02) + Scheduled (R-03, R-04) |
| Support | S | S-01 WhatsApp Support, S-02 RAG Brain, S-03 Review Alerts, S-04 CEO Assistant | WhatsApp trigger (S-01) + Webhook (S-02, S-04) + Scheduled (S-03) |
| Scale | SC | SC-01 UGC Collector, SC-02 Funnel Analytics, SC-03 Sales Auto, SC-04 SEO Meta | Scheduled (SC-01, SC-02) + Webhook (SC-03) + Shopify trigger (SC-04) |

---

## 2. Critical Bugs (Must Fix Before Production)

### BUG-01 — A-03: Wrong channel for Instagram DMs
**File:** A-03-ig-dm-workflow.json
**Node:** "Send DM (WhatsApp)" (`n8n-nodes-base.whatsApp`)
**Issue:** The workflow is designed to respond to Instagram events but sends replies via WhatsApp using the Instagram `user_id` as a phone number. These are completely different identifiers. An Instagram user_id (e.g., `12345678`) is not a phone number. This will always fail in production.
**Fix:** Replace with Instagram Messaging API (Graph API POST to `/messages`) using the IGSID (Instagram-Scoped User ID), or route through ManyChat's send-message API.

### BUG-02 — C-04: Discount codes never created in Shopify
**File:** C-04-gamified-checkout-workflow.json
**Node:** "Build Gamification" code node
**Issue:** `discountCode = 'SPIN' + Math.random()...` generates a code locally but never creates it as a Shopify discount. The frontend will show the code to the customer, but Shopify will reject it at checkout because it doesn't exist. A Shopify API call to `POST /admin/api/discount_codes.json` is missing.
**Fix:** Add a Shopify node after code generation to create the price rule + discount code before returning it.

### BUG-03 — C-04: Misuse of Webhook node as response mechanism
**File:** C-04-gamified-checkout-workflow.json
**Node:** "Return to Checkout" (`n8n-nodes-base.webhook`)
**Issue:** This node is a *trigger* (listens for incoming requests), not a responder. It's connected as if it will send data back to the checkout frontend, but it will just sit and wait for an incoming POST. The gamification config will never reach the storefront.
**Fix:** Replace with `respondToWebhook` (already used elsewhere in the codebase) that responds to the original Shopify checkout trigger.

### BUG-04 — S-03: Wrong Google My Business rating parser
**File:** S-03-review-alerts-workflow.json
**Code:** `parseInt(review.starRating.replace('STAR_', ''))`
**Issue:** The Google My Business API v4 returns star ratings as text strings: `"FIVE"`, `"FOUR"`, `"THREE"`, `"TWO"`, `"ONE"` — not `"STAR_5"`. The replace will have no effect, `parseInt("FIVE")` returns `NaN`, breaking all rating-based logic downstream.
**Fix:**
```js
const ratingMap = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 };
rating: ratingMap[review.starRating] || 0
```

### BUG-05 — SC-01: Instagram DM permission request will fail
**File:** SC-01-ugc-collector-workflow.json
**Node:** "Send Permission DM" HTTP node
**Issue:** Posts to `graph.instagram.com/me/messages` with `recipient = creator_handle` (a username string like `@johndoe`). Instagram's messaging API requires an IGSID (Instagram-Scoped User ID), not a username. This endpoint will return a 400 error for every permission DM.
**Fix:** Use a lookup call to resolve the username to an IGSID first, or use a service like ManyChat that handles username-to-IGSID resolution.

### BUG-06 — R-02: Customer phone/email never populated for tier upgrade notifications
**File:** R-02-loyalty-engine-workflow.json
**Nodes:** "Send WhatsApp" and "Send Email"
**Issue:** Both notification nodes reference `$json.customer_phone` and `$json.customer_email`, but the `Calculate Points` code only outputs loyalty account data (points, tier). No customer contact data is ever fetched or merged. Both sends will fail silently.
**Fix:** Add a `customers` table lookup after `Get Loyalty Account` and merge phone + email into the flow before the `Tier Upgraded?` branch.

### BUG-07 — C-01: Channel routing ignored — always sends email
**File:** C-01-cart-recovery-workflow.json
**Issue:** The AI recovery strategy recommends a channel (email/sms/whatsapp), but the scheduled recovery job only has a single "Send Recovery Email" node. If the AI recommends SMS or WhatsApp, nothing different happens. The AI recommendation is discarded.
**Fix:** Add an IF branch after "Fetch Due Recoveries" to route to the correct channel node.

---

## 3. Logic Errors

### LOGIC-01 — I-02: Placeholder revenue comparison
**File:** I-02-revenue-reports-workflow.json
**Code:** `const prevDayRevenue = totalRevenue * 0.95; // Placeholder`
**Issue:** Revenue change % is always ~5.26% (1/0.95). The anomaly detection comparing to yesterday is meaningless. This will generate false alerts or mask real ones.
**Fix:** Fetch yesterday's data from `daily_reports` Supabase table or add a second Shopify fetch with a 2-day range.

### LOGIC-02 — I-02: Mislabeled gross margin
**File:** I-02-revenue-reports-workflow.json
**Code:** `gross_margin: ((totalRevenue - adSpend) / totalRevenue * 100)`
**Issue:** This calculation only subtracts ad spend from revenue, not COGS. This is a contribution margin (or marketing efficiency metric), not gross margin. Labeling it "Gross Margin" in the report is misleading for financial decision-making.
**Fix:** Rename to `contribution_margin` or add a COGS field to the calculation.

### LOGIC-03 — A-02: Mark-as-sent runs regardless of email delivery
**File:** A-02-cold-email-workflow.json
**Connections:** `Parse Email` → `[Send via Brevo, Mark as Sent]` (parallel)
**Issue:** Both nodes fire simultaneously. If Brevo fails to send the email, Supabase is still updated with `email_sent: true`. The prospect will never be retried.
**Fix:** Connect `Mark as Sent` after `Send via Brevo` (sequentially, not in parallel).

### LOGIC-04 — R-03: Social post marked published before Instagram confirms
**File:** R-03-social-auto-workflow.json
**Connections:** `Parse Caption` → `[Post to Instagram, Mark Published]` (parallel)
**Issue:** Same pattern — DB is updated as published simultaneously with the post attempt. Failed Instagram posts leave a ghost "published" state in Supabase.
**Fix:** Move `Mark Published` to fire after `Post to Instagram` succeeds.

### LOGIC-05 — S-03: Deduplication window too short
**File:** S-03-review-alerts-workflow.json
**Issue:** New reviews are filtered by checking alerts from the last 1 hour. The scheduler runs every 15 minutes. If a review arrives, gets processed at minute 0, and the `review_alerts` table is queried at minute 75 (next check after 60-minute window expires), the same review will be alerted again.
**Fix:** Check against all `review_alerts` by `review_id` without a time filter (use a unique constraint on `review_id` in the table).

### LOGIC-06 — S-04: One-tap CEO commands are never handled
**File:** S-04-ceo-assistant-workflow.json
**Issue:** The WhatsApp message tells the CEO to "Reply 1, 2, or 3 to execute." There is no corresponding workflow that listens for this reply and executes the chosen action. The feature is cosmetic.
**Fix:** Create a companion workflow triggered by incoming WhatsApp from the CEO's number that parses the reply and dispatches to the appropriate action webhook.

### LOGIC-07 — C-02: Merge data node receives wrong input indexes
**File:** C-02-inventory-drop-workflow.json
**Issue:** The `Merge Data` code references `$input.all()[0...3]`, expecting inventory data at [0], waitlist at [1], VIPs at [2], and AI response at [3]. But the connection flow is: `Parse Inventory` → `[Get Waitlist, Get VIP List]` → `AI: Write Messages` → `Merge Data`. At `Merge Data`, only `AI: Write Messages` output is the direct input. The other items aren't automatically carried forward in n8n's data model.
**Fix:** Use a `Merge` node to combine inventory + waitlist + VIP + AI outputs before the code node, or restructure to pass all context through the AI node's input.

### LOGIC-08 — I-01: Scrape data field reference
**File:** I-01-competitor-tracker-workflow.json
**Code:** `website content: {{ $json.data.substring(0, 1000) }}`
**Issue:** The HTTP Request node's response body is in `$json.data` for some configurations but in `$json.body` or directly as the response depending on the response format setting. Without `responseFormat: 'text'`, this can be an empty string or undefined.
**Fix:** Set the HTTP node to `responseFormat: 'text'` and reference `$json.body` explicitly.

---

## 4. Redundancies

| Pattern | Affected Workflows | Issue |
|---------|-------------------|-------|
| JSON parse try/catch | All 24 | Identical 8-line block duplicated everywhere. Should be a shared utility. |
| Slack notification node | All 24 | Each workflow has its own Slack node. A centralized `notify()` call would reduce 24 instances to a single shared function. |
| Customer lookup by email/phone/id | A-01, C-01, C-04, R-01, R-02, S-01, I-03, SC-03 | 8 separate identical Supabase selects against `customers`. Should be shared middleware. |
| Brevo email send | A-02, C-01, C-02, R-01, R-02, R-04, SC-03 | Same node config duplicated 7 times. Centralize into a `sendEmail()` utility. |
| OpenAI credential | All 24 | All reference `YOUR_OPENAI_CREDENTIAL_ID`. Single credential, could use an env var directly. |
| Daily 8 AM schedule trigger | I-02, SC-02 | Both fire at the same time and both query Shopify orders for the previous period. They will hit Shopify API twice simultaneously. Stagger or merge. |
| Daily 9 AM schedule trigger | A-02 (cold email), R-04 (winback) | Same time, could cause resource spikes. |

---

## 5. White-Labeling Issues

Every workflow has hardcoded brand-specific values that break the plug-and-play model:

| Hardcoded Value | Location | Should Be |
|-----------------|----------|-----------|
| `yourstore.com/products/` | A-03, C-01 | `config.brand.store_url` |
| `calendly.com/yourname/15min` | A-03, SC-03 | `config.brand.calendly_url` |
| `strategy@yourcompany.com` | I-01 | `config.brand.strategy_email` |
| `ops@yourcompany.com` | I-02 | `config.brand.ops_email` |
| `finance@yourcompany.com` | I-04 | `config.brand.finance_email` |
| `manager@yourcompany.com` | S-03 | `config.brand.manager_email` |
| `#leads`, `#outreach`, etc. | All 24 | `config.brand.slack_channels.{name}` |
| Free shipping threshold `$75` | C-04 | `config.brand.free_shipping_threshold` |
| Tax rates (US-CA, GB, EU…) | I-04 | `config.tax.rates` (per-jurisdiction config) |
| `gpt-4o-mini` model | All AI nodes | `config.ai.model` |
| `$0.95` prev revenue placeholder | I-02 | Real data fetch |

---

## 6. Missing Error Handling

| Workflow | Missing |
|----------|---------|
| A-02 | No retry on Brevo failure |
| A-03 | No handling when IG user_id lookup fails |
| C-01 | Recovery scheduler sends email to NULL customer_email without guard |
| C-03 | No handling when Amazon listing ASIN not found |
| I-01 | HTTP scrape with `continueOnFail: true` but no branch for empty response |
| R-03 | No handling when content_calendar is empty (workflow silently stops) |
| S-02 | Pinecone `$json.documents` field name may not match actual node output key |
| SC-04 | Shopify metafields update uses incorrect structure (missing namespace/key) |

---

## 7. Missing email credentials
Workflows I-01, I-02, I-04, S-03 all use the `n8n-nodes-base.sendEmail` node but have **no credentials specified**. These nodes will fail without an SMTP credential configured.

---

## 8. Summary by Severity

| Severity | Count | Items |
|----------|-------|-------|
| Critical (blocks production) | 7 | BUG-01 through BUG-07 |
| High (data quality / reliability) | 8 | LOGIC-01 through LOGIC-08 |
| Medium (redundancy / maintainability) | 7 | All redundancy patterns |
| Low (polish / white-label readiness) | 11+ | All hardcoded values |
| Missing credentials | 4 | I-01, I-02, I-04, S-03 email nodes |

---

## 9. What Works Well

- Overall workflow architecture is sound and covers the full D2C lifecycle
- All workflows have proper fallback JSON parsing
- Supabase logging is consistent across all workflows
- `splitInBatches` + loop-back pattern is correctly implemented in A-02, C-03, I-01, R-04
- `continueOnFail: true` is correctly used on external HTTP calls and non-critical Supabase fetches
- Slack notifications provide good operational visibility
- The 6-pillar structure (A/C/I/R/S/SC) is logical, non-overlapping, and well-tagged
- RFM segmentation in R-01 is a solid CRM foundation
- RAG architecture in S-02 is well-structured with proper confidence-gating
- Loyalty tier system in R-02 is commercially sound (bronze/silver/gold/platinum)
