'use strict';

/* ════════════════════════════════════════════════
   D2C AI Growth Suite — Frontend Application
   ════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────
const state = {
  slug:   null,
  key:    null,
  config: null,
  cache:  {},
  demo:   false,
};

// ── Cascade display map (mirrors api/orchestrator.js CASCADE_MAP) ─────────
const CASCADE_DISPLAY = {
  'A-01': [{ to: 'SC-03', label: 'Hot lead → sales follow-up' }],
  'C-01': [{ to: 'I-03',  label: 'Repeated abandonment → churn intel' }],
  'C-04': [{ to: 'I-03',  label: 'Gamification engaged → customer intel' }],
  'R-01': [{ to: 'R-02',  label: 'New order → loyalty points' }, { to: 'I-03', label: 'New order → customer intel' }],
  'R-02': [{ to: 'S-04',  label: 'Tier upgrade → CEO alert' }],
  'I-03': [{ to: 'R-04',  label: 'High churn risk → winback' }],
  'S-01': [{ to: 'S-02',  label: 'Query → RAG lookup' }, { to: 'S-04', label: 'Escalated → CEO alert' }],
  'S-02': [{ to: 'S-04',  label: 'Low confidence → CEO escalation' }],
  'S-03': [{ to: 'S-04',  label: 'Critical review → CEO alert' }, { to: 'SC-04', label: 'Product mention → refresh SEO' }],
  'SC-03':[{ to: 'A-01',  label: 'High intent → create lead' }],
  'SC-04':[{ to: 'A-04',  label: 'New product → generate content' }],
};

// Which workflows receive cascades from others (reverse map — for "triggered by" display)
const CASCADE_RECEIVES = (function () {
  var r = {};
  Object.keys(CASCADE_DISPLAY).forEach(function (from) {
    CASCADE_DISPLAY[from].forEach(function (c) {
      if (!r[c.to]) r[c.to] = [];
      r[c.to].push({ from: from, label: c.label });
    });
  });
  return r;
}());

// ── Per-workflow config options ───────────────────────
// Each entry: { key, label, type, default, description, options? }
// Stored as JSON in workflow_states.config_overrides

const WORKFLOW_CONFIG = {
  'A-01': [
    { key: 'hot_score',       label: 'Hot lead threshold',   type: 'number', default: 75,   desc: 'Score ≥ this triggers Slack hot-lead alert + SC-03 cascade' },
    { key: 'auto_enrich',     label: 'Auto-enrich leads',    type: 'bool',   default: true,  desc: 'Attempt to enrich missing fields before scoring' },
    { key: 'notify_all',      label: 'Notify on every lead', type: 'bool',   default: false, desc: 'Send Slack notification for warm/cold leads too' },
    { key: 'sources',         label: 'Tracked sources',      type: 'text',   default: 'website_form,chatbot,ads', desc: 'Comma-separated list of accepted source values' },
  ],
  'A-02': [
    { key: 'daily_limit',     label: 'Daily send limit',     type: 'number', default: 50,    desc: 'Max cold emails per day' },
    { key: 'send_hour',       label: 'Send hour (UTC)',       type: 'number', default: 9,     desc: '0–23, hour at which the daily batch runs' },
    { key: 'tone',            label: 'Email tone',           type: 'select', default: 'professional', options: ['professional','friendly','bold','concise'], desc: 'AI writing tone for generated emails' },
    { key: 'subject_prefix',  label: 'Subject prefix',       type: 'text',   default: '',    desc: 'Optional prefix prepended to every subject line' },
  ],
  'A-03': [
    { key: 'auto_reply',      label: 'Auto-reply enabled',   type: 'bool',   default: true,  desc: 'Send AI-generated reply without human approval' },
    { key: 'reply_delay_s',   label: 'Reply delay (secs)',   type: 'number', default: 3,     desc: 'Seconds to wait before sending — prevents instant-bot feel' },
    { key: 'cta_type',        label: 'Call to action',       type: 'select', default: 'shop', options: ['shop','book','learn','none'], desc: 'CTA injected at end of each reply' },
    { key: 'escalate_words',  label: 'Escalation keywords',  type: 'text',   default: 'refund,broken,angry,lawyer', desc: 'Comma-separated words that trigger human escalation' },
  ],
  'A-04': [
    { key: 'frequency',       label: 'Run frequency',        type: 'select', default: 'weekly', options: ['daily','weekly','biweekly'], desc: 'How often to generate new content' },
    { key: 'min_words',       label: 'Min word count',       type: 'number', default: 1200,  desc: 'Target minimum word count for generated articles' },
    { key: 'post_to_blog',    label: 'Auto-post to blog',    type: 'bool',   default: false, desc: 'Publish directly via Shopify blog API after generation' },
    { key: 'keywords',        label: 'Seed keywords',        type: 'text',   default: '',    desc: 'Comma-separated keywords; rotated each run' },
  ],
  'C-01': [
    { key: 'delay_1h_pct',    label: '1h discount %',        type: 'number', default: 0,     desc: 'Discount % for first recovery email (0 = no discount)' },
    { key: 'delay_4h_pct',    label: '4h discount %',        type: 'number', default: 5,     desc: 'Discount % for second recovery email' },
    { key: 'delay_24h_pct',   label: '24h discount %',       type: 'number', default: 10,    desc: 'Discount % for final recovery email' },
    { key: 'channels',        label: 'Recovery channels',    type: 'text',   default: 'email,whatsapp', desc: 'Comma-separated: email, whatsapp, sms' },
    { key: 'min_cart_value',  label: 'Min cart value ($)',   type: 'number', default: 20,    desc: 'Ignore abandoned carts below this value' },
  ],
  'C-02': [
    { key: 'early_access_h',  label: 'VIP early access (hrs)', type: 'number', default: 2,   desc: 'Hours before public announcement VIPs are notified' },
    { key: 'min_restock_qty', label: 'Min restock qty',      type: 'number', default: 5,     desc: 'Only alert if restocked quantity exceeds this' },
    { key: 'send_whatsapp',   label: 'WhatsApp alerts',      type: 'bool',   default: true,  desc: 'Send WhatsApp notifications in addition to email' },
  ],
  'C-03': [
    { key: 'max_per_run',     label: 'Listings per run',     type: 'number', default: 10,    desc: 'Max Amazon listings to optimise per weekly run' },
    { key: 'require_approval',label: 'Require approval',     type: 'bool',   default: true,  desc: 'Post to Slack for approval before applying changes' },
    { key: 'focus_on',        label: 'Optimise focus',       type: 'select', default: 'both', options: ['title','bullets','both'], desc: 'Which listing elements to rewrite' },
  ],
  'C-04': [
    { key: 'game_types',      label: 'Game types',           type: 'text',   default: 'spin_wheel,mystery_box,progress_bar', desc: 'Comma-separated game types AI can choose from' },
    { key: 'min_cart_value',  label: 'Min cart value ($)',   type: 'number', default: 30,    desc: 'Gamification only activates above this cart value' },
    { key: 'discount_min',    label: 'Min discount %',       type: 'number', default: 5,     desc: 'Smallest discount that can be awarded' },
    { key: 'discount_max',    label: 'Max discount %',       type: 'number', default: 20,    desc: 'Largest discount that can be awarded' },
  ],
  'I-01': [
    { key: 'check_freq',      label: 'Check frequency',      type: 'select', default: 'daily', options: ['hourly','daily','weekly'], desc: 'How often to scrape competitor sites' },
    { key: 'threat_threshold',label: 'Alert threshold (1-5)',type: 'number', default: 3,     desc: 'Threat level at which Slack alert fires' },
    { key: 'track_pricing',   label: 'Track pricing',        type: 'bool',   default: true,  desc: 'Watch for price changes on competitor products' },
    { key: 'track_copy',      label: 'Track copy changes',   type: 'bool',   default: true,  desc: 'Detect headline and description changes' },
    { key: 'competitors',     label: 'Competitor URLs',      type: 'text',   default: '',    desc: 'Comma-separated URLs to monitor' },
  ],
  'I-02': [
    { key: 'report_hour',     label: 'Report hour (UTC)',    type: 'number', default: 7,     desc: 'Hour daily revenue report is generated and sent' },
    { key: 'roas_threshold',  label: 'ROAS alert threshold', type: 'number', default: 2.0,   desc: 'Alert when ROAS drops below this value' },
    { key: 'margin_threshold',label: 'Margin alert %',       type: 'number', default: 30,    desc: 'Alert when gross margin drops below this %' },
    { key: 'include_channels',label: 'Ad channels',          type: 'text',   default: 'meta,google', desc: 'Comma-separated ad channels to include in ROAS' },
  ],
  'I-03': [
    { key: 'churn_threshold', label: 'Churn risk threshold', type: 'number', default: 0.7,   desc: '0.0–1.0; triggers R-04 winback cascade above this score' },
    { key: 'ltv_horizon_days',label: 'LTV horizon (days)',   type: 'number', default: 365,   desc: 'Prediction window for lifetime value calculation' },
    { key: 'auto_winback',    label: 'Auto-trigger winback', type: 'bool',   default: true,  desc: 'Cascade to R-04 automatically when churn risk is high' },
  ],
  'I-04': [
    { key: 'report_day',      label: 'Report day of month',  type: 'number', default: 1,     desc: '1–28, day monthly tax report is generated' },
    { key: 'jurisdictions',   label: 'Jurisdictions',        type: 'text',   default: 'CA,NY,TX,GB,EU', desc: 'Comma-separated tax jurisdictions to calculate' },
    { key: 'auto_email',      label: 'Auto-email finance',   type: 'bool',   default: true,  desc: 'Email report to finance_email on completion' },
  ],
  'R-01': [
    { key: 'welcome_delay_m', label: 'Welcome email delay (min)', type: 'number', default: 5, desc: 'Minutes after order to send the welcome/thank-you email' },
    { key: 'upsell_on_return',label: 'Upsell for returning', type: 'bool',   default: true,  desc: 'Include product recommendations for returning customers' },
  ],
  'R-02': [
    { key: 'purchase_rate',   label: 'Points per $1 spent',  type: 'number', default: 1,     desc: 'Loyalty points earned per dollar spent' },
    { key: 'referral_bonus',  label: 'Referral bonus pts',   type: 'number', default: 50,    desc: 'Points awarded for a successful referral' },
    { key: 'review_bonus',    label: 'Review bonus pts',     type: 'number', default: 25,    desc: 'Points awarded for submitting a review' },
    { key: 'social_bonus',    label: 'Social share bonus pts', type: 'number', default: 10,  desc: 'Points awarded for social media shares' },
    { key: 'silver_at',       label: 'Silver tier at (pts)', type: 'number', default: 500,   desc: 'Point threshold to reach Silver tier' },
    { key: 'gold_at',         label: 'Gold tier at (pts)',   type: 'number', default: 1500,  desc: 'Point threshold to reach Gold tier' },
    { key: 'platinum_at',     label: 'Platinum tier at (pts)', type: 'number', default: 5000, desc: 'Point threshold to reach Platinum tier' },
  ],
  'R-03': [
    { key: 'post_times',      label: 'Post times (UTC)',     type: 'text',   default: '10,14,18', desc: 'Comma-separated hours to post (e.g. 10,14,18)' },
    { key: 'hashtag_count',   label: 'Hashtags per post',    type: 'number', default: 8,     desc: 'Number of hashtags AI appends to each caption' },
    { key: 'auto_approve',    label: 'Auto-approve posts',   type: 'bool',   default: false, desc: 'Post without human review (disable for brand safety)' },
    { key: 'caption_tone',    label: 'Caption tone',         type: 'select', default: 'engaging', options: ['engaging','educational','promotional','minimal'], desc: 'Tone for AI-generated captions' },
  ],
  'R-04': [
    { key: 'stage1_days',     label: 'Stage 1 (days inactive)', type: 'number', default: 60, desc: 'Days of inactivity before Stage 1 winback message' },
    { key: 'stage2_days',     label: 'Stage 2 (days inactive)', type: 'number', default: 90, desc: 'Days of inactivity before Stage 2 (stronger offer)' },
    { key: 'stage3_days',     label: 'Stage 3 (days inactive)', type: 'number', default: 120, desc: 'Days before last-chance Stage 3 message' },
    { key: 'incentive_type',  label: 'Incentive type',       type: 'select', default: 'discount', options: ['discount','free_shipping','gift','none'], desc: 'Type of incentive included in winback emails' },
    { key: 'max_attempts',    label: 'Max attempts',         type: 'number', default: 3,     desc: 'Stop winback sequence after this many unanswered messages' },
  ],
  'S-01': [
    { key: 'auto_reply',      label: 'Auto-reply enabled',   type: 'bool',   default: true,  desc: 'Send AI reply without human approval' },
    { key: 'business_hours',  label: 'Business hours (UTC)', type: 'text',   default: '8-20', desc: 'Format: start-end (e.g. 8-20). Auto-reply disabled outside hours' },
    { key: 'escalate_to',     label: 'Escalate to',          type: 'select', default: 'slack', options: ['slack','email','ceo_whatsapp'], desc: 'Where to route escalated tickets' },
    { key: 'escalation_score',label: 'Escalation threshold', type: 'number', default: 7,     desc: '1–10 urgency score at which auto-escalation fires' },
  ],
  'S-02': [
    { key: 'confidence_min',  label: 'Confidence threshold', type: 'number', default: 0.5,   desc: '0.0–1.0; answers below this escalate to S-04' },
    { key: 'max_sources',     label: 'Max KB sources',       type: 'number', default: 5,     desc: 'Max knowledge base chunks retrieved per query' },
    { key: 'kb_namespace',    label: 'Pinecone namespace',   type: 'text',   default: 'support', desc: 'Pinecone namespace for this tenant knowledge base' },
  ],
  'S-03': [
    { key: 'check_interval_m',label: 'Check interval (min)', type: 'number', default: 15,    desc: 'How often to poll Google My Business for new reviews' },
    { key: 'critical_rating', label: 'Critical rating ≤',   type: 'number', default: 2,     desc: 'Star rating at or below which review is flagged critical' },
    { key: 'platforms',       label: 'Review platforms',    type: 'text',   default: 'google', desc: 'Comma-separated: google, trustpilot, shopify' },
  ],
  'S-04': [
    { key: 'digest_hour',     label: 'Daily digest hour (UTC)', type: 'number', default: 8,  desc: 'Hour at which daily CEO digest is sent' },
    { key: 'severity_filter', label: 'Min severity to alert', type: 'select', default: 'medium', options: ['low','medium','high','critical'], desc: 'Only send alerts at or above this severity' },
    { key: 'send_whatsapp',   label: 'WhatsApp alerts',     type: 'bool',   default: true,   desc: 'Send CEO alerts via WhatsApp' },
  ],
  'SC-01': [
    { key: 'check_interval_h',label: 'Check interval (hrs)', type: 'number', default: 6,     desc: 'How often to scan Instagram for tagged posts' },
    { key: 'min_quality',     label: 'Min quality score',   type: 'number', default: 0.6,   desc: '0.0–1.0; posts below this score are discarded' },
    { key: 'auto_request',    label: 'Auto-request permission', type: 'bool', default: true,  desc: 'Automatically DM creator to request usage rights' },
  ],
  'SC-02': [
    { key: 'report_hour',     label: 'Report hour (UTC)',   type: 'number', default: 8,      desc: 'Hour daily funnel report is generated' },
    { key: 'drop_alert_pct',  label: 'Drop alert threshold %', type: 'number', default: 20, desc: 'Alert when funnel stage conversion drops by this %' },
    { key: 'stages',          label: 'Funnel stages',       type: 'text',   default: 'awareness,interest,consideration,checkout,purchase', desc: 'Comma-separated funnel stage names' },
  ],
  'SC-03': [
    { key: 'intent_threshold',label: 'High intent score',   type: 'number', default: 7,     desc: '1–10; signals above this trigger A-01 lead cascade' },
    { key: 'follow_up_days',  label: 'Follow-up cadence (days)', type: 'text', default: '0,3,7', desc: 'Comma-separated days after signal to follow up' },
    { key: 'channels',        label: 'Outreach channels',   type: 'text',   default: 'email', desc: 'Comma-separated: email, whatsapp' },
  ],
  'SC-04': [
    { key: 'auto_publish',    label: 'Auto-publish to Shopify', type: 'bool', default: true,  desc: 'Push generated meta tags directly to Shopify product' },
    { key: 'title_max',       label: 'Title max length',    type: 'number', default: 60,    desc: 'Max characters for SEO meta title' },
    { key: 'desc_max',        label: 'Description max length', type: 'number', default: 160, desc: 'Max characters for SEO meta description' },
  ],
};

// ── Orchestrator SSE state ────────────────────────────
var sseSource = null;
var cascadeLog = [];   // ring buffer, max 50 events
var cascadeLogListeners = [];

function connectOrchestratorFeed() {
  if (state.demo || !state.slug || !state.key) return;
  if (sseSource) { sseSource.close(); sseSource = null; }

  var url = '/api/tenants/' + encodeURIComponent(state.slug) + '/events?x-api-key=' + encodeURIComponent(state.key);
  // EventSource doesn't support custom headers, so pass key as query param and
  // the server reads it from req.query as a fallback.
  sseSource = new EventSource(url);

  sseSource.onmessage = function (e) {
    try {
      var event = JSON.parse(e.data);
      cascadeLog.unshift(event);
      if (cascadeLog.length > 50) cascadeLog.pop();
      cascadeLogListeners.forEach(function (fn) { try { fn(event); } catch (_) {} });
    } catch (_) {}
  };

  sseSource.onerror = function () {
    // EventSource auto-reconnects; just log
    console.warn('[SSE] Orchestrator feed connection issue — will retry');
  };
}

function onCascadeEvent(fn) {
  cascadeLogListeners.push(fn);
  return function off() {
    cascadeLogListeners = cascadeLogListeners.filter(function (f) { return f !== fn; });
  };
}

// ── Workflow manifest ──────────────────────────────
const CATEGORIES = [
  { id: 'acquire', label: 'Acquire', color: '#38bdf8', workflows: [
    { id: 'A-01', name: 'Lead Capture',     desc: 'Captures and scores inbound leads from web forms' },
    { id: 'A-02', name: 'Cold Email',        desc: 'AI-personalised cold outreach sequences' },
    { id: 'A-03', name: 'Instagram DM Bot',  desc: 'Auto-responds to Instagram DMs and story replies' },
    { id: 'A-04', name: 'SEO Content',       desc: 'Generates SEO-optimised blog and product content' },
  ]},
  { id: 'convert', label: 'Convert', color: '#34d399', workflows: [
    { id: 'C-01', name: 'Cart Recovery',     desc: 'Multi-stage abandoned cart email + WhatsApp recovery' },
    { id: 'C-02', name: 'Inventory Drop',    desc: 'Back-in-stock alerts across email and WhatsApp' },
    { id: 'C-03', name: 'Amazon PDP',        desc: 'Optimises Amazon product detail listings with AI' },
    { id: 'C-04', name: 'Gamified Checkout', desc: 'Discount unlock gamification at checkout' },
  ]},
  { id: 'intelligence', label: 'Intelligence', color: '#a78bfa', workflows: [
    { id: 'I-01', name: 'Competitor Intel',  desc: 'Tracks competitor pricing and positioning changes' },
    { id: 'I-02', name: 'Revenue Analytics', desc: 'Daily revenue, ROAS, and margin reporting' },
    { id: 'I-03', name: 'Customer Intel',    desc: 'Customer behaviour analysis and segmentation' },
    { id: 'I-04', name: 'Tax Reports',       desc: 'Automated tax summary generation' },
  ]},
  { id: 'retain', label: 'Retain', color: '#fb923c', workflows: [
    { id: 'R-01', name: 'CRM Follow-up',     desc: 'Post-purchase CRM sequences and RFM scoring' },
    { id: 'R-02', name: 'Loyalty Engine',    desc: 'Points, rewards, and tier management' },
    { id: 'R-03', name: 'Social Automation', desc: 'Automated social posting and engagement' },
    { id: 'R-04', name: 'Winback',           desc: 'Churn prediction and re-engagement campaigns' },
  ]},
  { id: 'support', label: 'Support', color: '#f472b6', workflows: [
    { id: 'S-01', name: 'WhatsApp Support',  desc: 'AI-powered WhatsApp customer service' },
    { id: 'S-02', name: 'RAG Brain',         desc: 'Vector-search knowledge base for support queries' },
    { id: 'S-03', name: 'Review Alerts',     desc: 'Monitors and alerts on new customer reviews' },
    { id: 'S-04', name: 'CEO Assistant',     desc: 'Daily business digest and decision summaries' },
  ]},
  { id: 'scale', label: 'Scale', color: '#fbbf24', workflows: [
    { id: 'SC-01', name: 'UGC Collect',      desc: 'User-generated content collection and curation' },
    { id: 'SC-02', name: 'Funnel Analytics', desc: 'Full-funnel conversion analysis via GA4' },
    { id: 'SC-03', name: 'Sales Automation', desc: 'AI-driven outbound sales signals and follow-up' },
    { id: 'SC-04', name: 'SEO Meta',         desc: 'Auto-generates SEO meta tags for new products' },
  ]},
];

// ── Utilities ──────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function timeAgo(iso) {
  if (!iso) return 'Never';
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return mins + 'm ago';
  if (hours < 24) return hours + 'h ago';
  if (days < 7)   return days + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '$0';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

// ── Mock Data ──────────────────────────────────────
const MOCK_DATA = {
  config: {
    brand_name: 'Lumino Skin',
    tenants: { name: 'Lumino Skin', plan: 'Scale' },
    feature_loyalty: true,
    feature_gamification: true,
    feature_rag: true,
    feature_amazon: false,
    feature_ugc: true,
    feature_tax_reports: true,
    brand_logo: null,
    store_url: 'https://luminoskin.com'
  },
  workflows: [
    { workflow_id: 'A-01', is_active: true, run_count: 1242, error_count: 0, last_run_at: new Date(Date.now() - 1000 * 60 * 15).toISOString() },
    { workflow_id: 'A-02', is_active: true, run_count: 8500, error_count: 12, last_run_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString() },
    { workflow_id: 'C-01', is_active: true, run_count: 450, error_count: 2, last_run_at: new Date(Date.now() - 1000 * 60 * 30).toISOString() },
    { workflow_id: 'C-04', is_active: true, run_count: 2100, error_count: 0, last_run_at: new Date(Date.now() - 1000 * 60 * 5).toISOString() },
    { workflow_id: 'I-02', is_active: true, run_count: 31, error_count: 0, last_run_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() },
    { workflow_id: 'R-02', is_active: true, run_count: 125, error_count: 0, last_run_at: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString() },
    { workflow_id: 'S-02', is_active: true, run_count: 340, error_count: 5, last_run_at: new Date(Date.now() - 1000 * 60 * 20).toISOString() },
    { workflow_id: 'SC-01', is_active: false, run_count: 0, error_count: 0, last_run_at: null },
  ],
  analytics: {
    leads: Array.from({ length: 15 }, (_, i) => ({
      id: i,
      email: `user${i}@gmail.com`,
      score: 70 + Math.floor(Math.random() * 25),
      created_at: new Date(Date.now() - i * 1000 * 60 * 60 * 4).toISOString()
    })),
    carts: [
      { id: 1, email: 'sarah@example.com', value: 120, status: 'recovered', created_at: new Date(Date.now() - 1000 * 60 * 120).toISOString() },
      { id: 2, email: 'mike@test.io', value: 85, status: 'pending', created_at: new Date(Date.now() - 1000 * 60 * 45).toISOString() },
      { id: 3, email: 'jason@gmail.com', value: 240, status: 'recovered', created_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString() },
      { id: 4, email: 'anna@outlook.com', value: 45, status: 'lost', created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() },
    ]
  },
  integrations: [
    { id: 'openai', connected: true, env_var: 'OPENAI_API_KEY', workflows: ['A-02', 'A-04', 'C-03', 'S-01', 'S-02'] },
    { id: 'shopify', connected: true, env_var: 'SHOPIFY_ACCESS_TOKEN', workflows: ['C-01', 'C-02', 'R-02'] },
    { id: 'supabase', connected: true, env_var: 'SUPABASE_URL', workflows: ['A-01', 'I-03'] },
    { id: 'brevo', connected: true, env_var: 'BREVO_API_KEY', workflows: ['A-02', 'C-01', 'R-01', 'R-04'] },
    { id: 'pinecone', connected: true, env_var: 'PINECONE_API_KEY', workflows: ['S-02'] },
    { id: 'slack', connected: false, env_var: 'SLACK_BOT_TOKEN', workflows: ['S-03'] },
  ]
};

async function mockApi(path, opts) {
  await new Promise(r => setTimeout(r, 300));
  var method = opts && opts.method ? opts.method.toUpperCase() : 'GET';

  // Trigger endpoint — simulate a successful run
  if (path.includes('/trigger') && method === 'POST') {
    return { success: true, workflow_id: path.split('/').slice(-2, -1)[0], result: { status: 'ok', demo: true } };
  }
  // Workflow PATCH (toggle / save overrides)
  if (path.includes('/workflows/') && method === 'PATCH') {
    return { success: true };
  }
  // Default-payload endpoint
  if (path.includes('/default-payload')) return {};
  // Cascades map
  if (path.includes('/cascades')) {
    var out = {};
    Object.keys(CASCADE_DISPLAY).forEach(function (k) { out[k] = CASCADE_DISPLAY[k].map(function (c) { return { triggers: c.to, label: c.label }; }); });
    return out;
  }

  if (path.includes('/api/config/')) return MOCK_DATA.config;
  if (path.includes('/workflows'))   return MOCK_DATA.workflows;
  if (path.includes('/analytics'))   return MOCK_DATA.analytics;
  if (path.includes('/integrations'))return MOCK_DATA.integrations;
  if (method === 'PATCH' || method === 'PUT') return { success: true };
  return {};
}

// ── API ────────────────────────────────────────────
async function api(path, opts) {
  if (state.demo) return mockApi(path, opts);
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (state.key) headers['x-api-key'] = state.key;
  const res = await fetch(path, Object.assign({}, opts, { headers: Object.assign({}, headers, opts.headers || {}) }));
  if (!res.ok) {
    let errMsg = 'HTTP ' + res.status;
    try { const j = await res.json(); errMsg = j.error || errMsg; } catch (_) {}
    throw new Error(errMsg);
  }
  return res.json();
}

// ── Toast ──────────────────────────────────────────
function toast(msg, type) {
  type = type || 'success';
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;

  const iconSvg = type === 'success'
    ? '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

  el.innerHTML = iconSvg + '<span>' + esc(msg) + '</span>';
  container.appendChild(el);

  const dismiss = function () {
    el.classList.add('hiding');
    setTimeout(function () { el.remove(); }, 260);
  };

  const timer = setTimeout(dismiss, 3000);
  el.addEventListener('click', function () { clearTimeout(timer); dismiss(); });
}

// ── Screen navigation ──────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function (s) {
    s.classList.toggle('hidden', s.id !== id);
  });
}

// ── App navigation ─────────────────────────────────
let currentView = 'overview';

async function go(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  const mc = document.getElementById('main-content');
  mc.innerHTML = renderSkeleton(view);

  try {
    let html = '';
    if (view === 'overview')      html = await viewOverview();
    else if (view === 'workflows')    html = await viewWorkflows();
    else if (view === 'analytics')    html = await viewAnalytics();
    else if (view === 'integrations') html = await viewIntegrations();
    else if (view === 'settings')     html = await viewSettings();
    mc.innerHTML = html;
    attachViewListeners(view, mc);
  } catch (err) {
    mc.innerHTML = '<div class="empty-state" style="padding-top:3rem">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="40" height="40"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      + '<p>Failed to load: ' + esc(err.message) + '</p></div>';
  }
}

function renderSkeleton(view) {
  var card = function (h) { return '<div class="skeleton" style="height:' + h + 'px;border-radius:0.75rem"></div>'; };
  if (view === 'overview') {
    return '<div class="view-header"><div class="skeleton" style="width:220px;height:28px;border-radius:6px"></div></div>'
      + '<div class="stat-grid" style="margin-bottom:2rem">' + [card(90), card(90), card(90), card(90)].join('') + '</div>'
      + '<div class="category-grid">' + [card(80), card(80), card(80), card(80), card(80), card(80)].join('') + '</div>';
  }
  if (view === 'workflows') {
    return CATEGORIES.map(function () {
      return '<div style="margin-bottom:2rem"><div class="skeleton" style="width:160px;height:20px;margin-bottom:1rem;border-radius:6px"></div>'
        + '<div class="wf-grid">' + [card(110), card(110), card(110), card(110)].join('') + '</div></div>';
    }).join('');
  }
  if (view === 'analytics') {
    return '<div class="analytics-metrics" style="margin-bottom:2rem">' + [card(90), card(90), card(90), card(90), card(90)].join('') + '</div>'
      + '<div class="analytics-tables">' + [card(240), card(240)].join('') + '</div>';
  }
  if (view === 'integrations') {
    return '<div class="integrations-grid">' + [card(150), card(150), card(150), card(150), card(150), card(150), card(150), card(150), card(150)].join('') + '</div>';
  }
  return '<div style="display:flex;flex-direction:column;gap:1rem">' + [card(100), card(100), card(100), card(100)].join('') + '</div>';
}

// ── Connect / Disconnect ───────────────────────────
async function connect(slug, key) {
  state.demo   = false;
  state.slug   = slug;
  state.key    = key;
  state.cache  = {};
  document.getElementById('demo-badge').classList.add('hidden');
  const config = await api('/api/config/' + encodeURIComponent(slug));
  state.config = config;

  const brandName = config.brand_name || (config.tenants && config.tenants.name) || slug;
  document.getElementById('tenant-name').textContent = brandName;
  document.getElementById('tenant-avatar').textContent = brandName.charAt(0).toUpperCase();

  const plan = ((config.tenants && config.tenants.plan) || 'growth').toLowerCase();
  const pp = document.getElementById('tenant-plan-pill');
  pp.textContent = plan;
  pp.className = 'plan-pill plan-' + plan;

  showScreen('screen-app');
  connectOrchestratorFeed();
  go('overview');
}

async function connectDemo() {
  state.demo = true;
  state.slug = 'demo-workspace';
  state.key  = 'demo-key';
  state.cache = {};
  document.getElementById('demo-badge').classList.remove('hidden');
  
  const config = await api('/api/config/demo-workspace');
  state.config = config;
  
  document.getElementById('tenant-name').textContent = config.brand_name;
  document.getElementById('tenant-avatar').textContent = config.brand_name.charAt(0).toUpperCase();
  
  const plan = config.tenants.plan.toLowerCase();
  const pp = document.getElementById('tenant-plan-pill');
  pp.textContent = plan;
  pp.className = 'plan-pill plan-' + plan;
  
  showScreen('screen-app');
  // demo mode: no real SSE
  go('overview');
}

function disconnect() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  cascadeLog = [];
  cascadeLogListeners = [];
  state.slug   = null;
  state.key    = null;
  state.config = null;
  state.cache  = {};
  state.demo   = false;
  document.getElementById('demo-badge').classList.add('hidden');
  showScreen('screen-connect');
  document.getElementById('inp-slug').value = '';
  document.getElementById('inp-key').value  = '';
  document.getElementById('connect-error').classList.add('hidden');
}

// ── Cached fetches ─────────────────────────────────
async function fetchWorkflows() {
  if (state.cache.workflows) return state.cache.workflows;
  const data = await api('/api/tenants/' + encodeURIComponent(state.slug) + '/workflows');
  state.cache.workflows = data;
  return data;
}

async function fetchAnalytics() {
  if (state.cache.analytics) return state.cache.analytics;
  const data = await api('/api/tenants/' + encodeURIComponent(state.slug) + '/analytics');
  state.cache.analytics = data;
  return data;
}

async function fetchIntegrations() {
  if (state.cache.integrations) return state.cache.integrations;
  const data = await api('/api/tenants/' + encodeURIComponent(state.slug) + '/integrations');
  state.cache.integrations = data;
  return data;
}

// ── View: Overview ─────────────────────────────────
async function viewOverview() {
  var results = await Promise.all([fetchWorkflows(), fetchAnalytics()]);
  var wfStates = results[0] || [];
  var analytics = results[1] || {};

  var wfMap = {};
  wfStates.forEach(function (w) { wfMap[w.workflow_id] = w; });

  var activeCount = wfStates.filter(function (w) { return w.is_active; }).length;
  var totalRuns   = wfStates.reduce(function (s, w) { return s + (w.run_count || 0); }, 0);

  var now = new Date();
  var leadsThisMonth = (analytics.leads || []).filter(function (l) {
    var d = new Date(l.created_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  var cartsRecovered = (analytics.carts || []).filter(function (c) { return c.status === 'recovered'; }).length;

  var brandName = esc(state.config && state.config.brand_name
    ? state.config.brand_name
    : (state.config && state.config.tenants && state.config.tenants.name
        ? state.config.tenants.name
        : state.slug));

  var catCards = CATEGORIES.map(function (cat, i) {
    var active = cat.workflows.filter(function (wf) { return wfMap[wf.id] && wfMap[wf.id].is_active; }).length;
    var total  = cat.workflows.length;
    var pct    = Math.round((active / total) * 100);
    return '<div class="cat-health-card" style="animation-delay:' + (i * 40) + 'ms">'
      + '<div class="cat-health-header">'
      + '<span class="cat-health-name">' + esc(cat.label) + '</span>'
      + '<span style="font-size:0.75rem;font-weight:600;color:' + esc(cat.color) + '">' + active + '/' + total + '</span>'
      + '</div>'
      + '<div class="cat-health-bar-wrap"><div class="cat-health-bar" style="width:' + pct + '%;background:' + esc(cat.color) + '"></div></div>'
      + '<div class="cat-health-count">' + active + ' active workflow' + (active !== 1 ? 's' : '') + '</div>'
      + '</div>';
  }).join('');

  return '<div class="view-header">'
    + '<div class="view-greeting">Good ' + getGreeting() + ', ' + brandName + '</div>'
    + '<div class="view-sub">Here\'s your AI workflow dashboard</div>'
    + '</div>'
    + '<div class="stat-grid">'
    + '<div class="stat-card"><div class="stat-label">Active Workflows</div><div class="stat-value">' + fmtNum(activeCount) + '</div><div class="stat-change">of ' + (CATEGORIES.length * 4) + ' total</div></div>'
    + '<div class="stat-card"><div class="stat-label">Leads This Month</div><div class="stat-value">' + fmtNum(leadsThisMonth) + '</div><div class="stat-change">captured &amp; scored</div></div>'
    + '<div class="stat-card"><div class="stat-label">Carts Recovered</div><div class="stat-value">' + fmtNum(cartsRecovered) + '</div><div class="stat-change">all-time recoveries</div></div>'
    + '<div class="stat-card"><div class="stat-label">Total Runs</div><div class="stat-value">' + fmtNum(totalRuns) + '</div><div class="stat-change">across all workflows</div></div>'
    + '</div>'
    + '<div class="section-title">Category Health</div>'
    + '<div class="category-grid">' + catCards + '</div>';
}

// ── View: Workflows ────────────────────────────────
async function viewWorkflows() {
  var wfStates = await fetchWorkflows();
  var wfMap = {};
  (wfStates || []).forEach(function (w) { wfMap[w.workflow_id] = w; });

  var sections = CATEGORIES.map(function (cat, ci) {
    var activeInCat = cat.workflows.filter(function (wf) { return wfMap[wf.id] && wfMap[wf.id].is_active; }).length;

    var cards = cat.workflows.map(function (wf) {
      var sd       = wfMap[wf.id] || {};
      var isActive = !!sd.is_active;
      var runCount = sd.run_count   || 0;
      var errCount = sd.error_count || 0;
      var lastRun  = timeAgo(sd.last_run_at);

      // Cascade arrows: outgoing + incoming
      var outgoing = (CASCADE_DISPLAY[wf.id] || []).map(function (c) {
        return '<span class="cascade-badge out" title="Triggers ' + esc(c.to) + ': ' + esc(c.label) + '">→ ' + esc(c.to) + '</span>';
      }).join('');
      var incoming = (CASCADE_RECEIVES[wf.id] || []).map(function (c) {
        return '<span class="cascade-badge in" title="Triggered by ' + esc(c.from) + ': ' + esc(c.label) + '">← ' + esc(c.from) + '</span>';
      }).join('');
      var cascadeBadges = (outgoing || incoming)
        ? '<div class="wf-cascades">' + outgoing + incoming + '</div>'
        : '';

      return '<div class="wf-card" data-wf-id="' + esc(wf.id) + '">'
        + '<div class="wf-card-top">'
        + '<div class="wf-card-info">'
        + '<div class="wf-id-badge" style="background:' + hexAlpha(cat.color, 0.15) + ';color:' + esc(cat.color) + '">' + esc(wf.id) + '</div>'
        + '<div class="wf-name">' + esc(wf.name) + '</div>'
        + '<div class="wf-desc">' + esc(wf.desc) + '</div>'
        + '</div>'
        + '<label class="toggle-wrap" title="' + (isActive ? 'Disable' : 'Enable') + ' workflow">'
        + '<input type="checkbox" class="toggle-input" data-wf-id="' + esc(wf.id) + '" ' + (isActive ? 'checked' : '') + ' />'
        + '<span class="toggle-track"></span>'
        + '</label>'
        + '</div>'
        + cascadeBadges
        + '<div class="wf-stats">'
        + '<div class="wf-stat"><span class="wf-stat-val">' + fmtNum(runCount) + '</span><span class="wf-stat-label">Runs</span></div>'
        + '<div class="wf-stat"><span class="wf-stat-val' + (errCount > 0 ? ' error-val' : '') + '">' + fmtNum(errCount) + '</span><span class="wf-stat-label">Errors</span></div>'
        + '<div class="wf-stat"><span class="wf-stat-val last-run">' + esc(lastRun) + '</span><span class="wf-stat-label">Last run</span></div>'
        + '</div>'
        + '<div class="wf-card-actions">'
        + '<button class="btn btn-ghost btn-xs wf-configure-btn" data-wf-id="' + esc(wf.id) + '" data-cat-color="' + esc(cat.color) + '">Configure</button>'
        + '<button class="btn btn-primary btn-xs wf-trigger-btn" data-wf-id="' + esc(wf.id) + '" title="Manually run this workflow">Run now</button>'
        + '</div>'
        + '</div>';
    }).join('');

    return '<div class="category-section" style="animation-delay:' + (ci * 50) + 'ms">'
      + '<div class="category-header" style="border-left-color:' + esc(cat.color) + '">'
      + '<span class="category-header-text">' + esc(cat.label) + '</span>'
      + '<span class="category-header-count">' + activeInCat + '/' + cat.workflows.length + ' active</span>'
      + '</div>'
      + '<div class="wf-grid">' + cards + '</div>'
      + '</div>';
  }).join('');

  return sections;
}

// ── View: Analytics ────────────────────────────────
async function viewAnalytics() {
  var data = await fetchAnalytics();
  var leads   = data.leads   || [];
  var carts   = data.carts   || [];
  var loyalty = data.loyalty || [];

  var totalLeads  = leads.length;
  var hotLeads    = leads.filter(function (l) { return (l.score || 0) >= 70; }).length;
  var recovered   = carts.filter(function (c) { return c.status === 'recovered'; });
  var cartsCount  = recovered.length;
  var recoveryVal = recovered.reduce(function (s, c) { return s + (c.recovery_value || 0); }, 0);
  var loyaltyPts  = loyalty.reduce(function (s, l) { return s + (l.points || 0); }, 0);

  var metrics = [
    { label: 'Total Leads',     value: fmtNum(totalLeads),   color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
    { label: 'Hot Leads',       value: fmtNum(hotLeads),     color: '#ef4444', bg: 'rgba(239,68,68,0.12)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>' },
    { label: 'Carts Recovered', value: fmtNum(cartsCount),   color: '#34d399', bg: 'rgba(52,211,153,0.12)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>' },
    { label: 'Recovery Value',  value: fmtCurrency(recoveryVal), color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
    { label: 'Loyalty Points',  value: fmtNum(loyaltyPts),   color: '#fb923c', bg: 'rgba(251,146,60,0.12)',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>' },
  ];

  var metricCards = metrics.map(function (m) {
    return '<div class="metric-card">'
      + '<div class="metric-icon" style="background:' + m.bg + ';color:' + m.color + '">' + m.icon + '</div>'
      + '<div class="metric-label">' + esc(m.label) + '</div>'
      + '<div class="metric-value">' + esc(m.value) + '</div>'
      + '</div>';
  }).join('');

  // Cart table (last 8 newest first)
  var cartRows = carts.slice(-8).reverse();
  var cartHtml = cartRows.length ? cartRows.map(function (c) {
    var sc = c.status === 'recovered' ? 'status-recovered' : c.status === 'pending' ? 'status-pending' : 'status-lost';
    return '<tr><td>' + fmtCurrency(c.cart_value) + '</td><td>' + fmtCurrency(c.recovery_value || 0) + '</td>'
      + '<td><span class="status-badge ' + sc + '">' + esc(c.status || 'unknown') + '</span></td>'
      + '<td class="text-3">' + timeAgo(c.created_at) + '</td></tr>';
  }).join('')
  : '<tr><td colspan="4"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg><p>No cart recovery data yet</p></div></td></tr>';

  // Leads table (last 8 newest first)
  var leadRows = leads.slice(-8).reverse();
  var leadHtml = leadRows.length ? leadRows.map(function (l) {
    var score = l.score || 0;
    var sc = score >= 70 ? 'status-hot' : score >= 40 ? 'status-warm' : 'status-cold';
    return '<tr><td><span class="status-badge ' + sc + '">' + score + '</span></td>'
      + '<td class="text-2">' + esc(l.category || 'inbound') + '</td>'
      + '<td class="text-3">' + timeAgo(l.created_at) + '</td></tr>';
  }).join('')
  : '<tr><td colspan="3"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>No lead data yet</p></div></td></tr>';

  return '<div class="view-header">'
    + '<div class="view-greeting">Analytics</div>'
    + '<div class="view-sub">Performance across AI workflows</div>'
    + '</div>'
    + '<div class="analytics-metrics">' + metricCards + '</div>'
    + '<div class="analytics-tables">'
    + '<div class="table-card"><div class="table-card-header">Cart Recovery</div>'
    + '<table class="data-table"><thead><tr><th>Cart Value</th><th>Recovered</th><th>Status</th><th>Time</th></tr></thead><tbody>' + cartHtml + '</tbody></table></div>'
    + '<div class="table-card"><div class="table-card-header">Recent Leads</div>'
    + '<table class="data-table"><thead><tr><th>Score</th><th>Category</th><th>Time</th></tr></thead><tbody>' + leadHtml + '</tbody></table></div>'
    + '</div>';
}

// ── View: Integrations ─────────────────────────────
async function viewIntegrations() {
  var integrations = await fetchIntegrations();

  if (!integrations || integrations.length === 0) {
    return '<div class="empty-state" style="padding-top:4rem">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'
      + '<p>No integration data available</p></div>';
  }

  var checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="24" height="24"><polyline points="20 6 9 17 4 12"/></svg>';
  var xIcon     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="24" height="24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  var cards = integrations.map(function (integ, i) {
    var ok = integ.connected;
    var wfBadges = (integ.workflows || []).map(function (w) {
      return '<span class="wf-badge-sm">' + esc(w) + '</span>';
    }).join('');

    return '<div class="integration-card ' + (ok ? 'connected' : 'disconnected') + '" style="animation-delay:' + (i * 40) + 'ms">'
      + '<div class="integration-status-icon ' + (ok ? 'ok' : 'err') + '">' + (ok ? checkIcon : xIcon) + '</div>'
      + '<div class="integration-name">' + esc(integ.label) + '</div>'
      + '<div class="integration-status-text ' + (ok ? 'ok' : 'err') + '">' + (ok ? 'Connected' : esc(integ.env_var)) + '</div>'
      + '<div class="integration-workflows">' + wfBadges + '</div>'
      + '</div>';
  }).join('');

  var connectedCount = integrations.filter(function (i) { return i.connected; }).length;

  return '<div class="view-header">'
    + '<div class="view-greeting">Integrations</div>'
    + '<div class="view-sub">' + connectedCount + ' of ' + integrations.length + ' services connected</div>'
    + '</div>'
    + '<div class="integrations-grid">' + cards + '</div>';
}

// ── View: Settings ─────────────────────────────────
async function viewSettings() {
  var cfg = state.config || {};

  function v(key, fallback) {
    fallback = fallback != null ? fallback : '';
    return esc(cfg[key] != null ? cfg[key] : fallback);
  }

  var chevronSvg = '<svg class="settings-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="6 9 12 15 18 9"/></svg>';

  var brandSection = '<div class="settings-section open" data-section="brand">'
    + '<button class="settings-section-trigger" data-toggle-section="brand"><span>Brand Identity</span>' + chevronSvg + '</button>'
    + '<div class="settings-section-body">'
    + '<div class="settings-field-grid">'
    + '<div class="field-group"><label class="field-label">Brand Name</label><input type="text" class="field-input" data-field="brand_name" value="' + v('brand_name') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Store URL</label><input type="url" class="field-input" data-field="store_url" value="' + v('store_url') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Brand Voice</label><input type="text" class="field-input" data-field="brand_voice" value="' + v('brand_voice') + '" placeholder="e.g. friendly, professional" /></div>'
    + '<div class="field-group"><label class="field-label">Calendly URL</label><input type="url" class="field-input" data-field="calendly_url" value="' + v('calendly_url') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Logo URL</label><input type="url" class="field-input" data-field="logo_url" value="' + v('logo_url') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Primary Color</label><input type="text" class="field-input" data-field="primary_color" value="' + v('primary_color') + '" placeholder="#38bdf8" /></div>'
    + '</div>'
    + '<div class="settings-footer"><span class="dirty-indicator" data-dirty="brand">Unsaved changes</span><button class="btn btn-primary btn-sm" data-settings-section="brand" disabled>Save changes</button></div>'
    + '</div></div>';

  var contactSection = '<div class="settings-section" data-section="contact">'
    + '<button class="settings-section-trigger" data-toggle-section="contact"><span>Contact Details</span>' + chevronSvg + '</button>'
    + '<div class="settings-section-body">'
    + '<div class="settings-field-grid">'
    + '<div class="field-group"><label class="field-label">Strategy Email</label><input type="email" class="field-input" data-field="strategy_email" value="' + v('strategy_email') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Ops Email</label><input type="email" class="field-input" data-field="ops_email" value="' + v('ops_email') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Finance Email</label><input type="email" class="field-input" data-field="finance_email" value="' + v('finance_email') + '" /></div>'
    + '<div class="field-group"><label class="field-label">Support Email</label><input type="email" class="field-input" data-field="support_email" value="' + v('support_email') + '" /></div>'
    + '<div class="field-group"><label class="field-label">CEO Phone (WhatsApp)</label><input type="tel" class="field-input" data-field="ceo_phone" value="' + v('ceo_phone') + '" placeholder="+1234567890" /></div>'
    + '</div>'
    + '<div class="settings-footer"><span class="dirty-indicator" data-dirty="contact">Unsaved changes</span><button class="btn btn-primary btn-sm" data-settings-section="contact" disabled>Save changes</button></div>'
    + '</div></div>';

  var featureFlags = [
    { key: 'feature_loyalty',      label: 'Loyalty Engine' },
    { key: 'feature_gamification', label: 'Gamified Checkout' },
    { key: 'feature_rag',          label: 'RAG Brain' },
    { key: 'feature_amazon',       label: 'Amazon PDP' },
    { key: 'feature_ugc',          label: 'UGC Collect' },
    { key: 'feature_tax_reports',  label: 'Tax Reports' },
  ];

  var flagCards = featureFlags.map(function (f) {
    return '<div class="settings-flag">'
      + '<span class="settings-flag-label">' + esc(f.label) + '</span>'
      + '<label class="toggle-wrap" title="Toggle ' + esc(f.label) + '">'
      + '<input type="checkbox" class="toggle-input" data-field="' + esc(f.key) + '"' + (cfg[f.key] ? ' checked' : '') + ' />'
      + '<span class="toggle-track"></span>'
      + '</label>'
      + '</div>';
  }).join('');

  var featureSection = '<div class="settings-section" data-section="features">'
    + '<button class="settings-section-trigger" data-toggle-section="features"><span>Feature Flags</span>' + chevronSvg + '</button>'
    + '<div class="settings-section-body">'
    + '<div class="settings-flag-grid">' + flagCards + '</div>'
    + '<div class="settings-footer"><span class="dirty-indicator" data-dirty="features">Unsaved changes</span><button class="btn btn-primary btn-sm" data-settings-section="features" disabled>Save changes</button></div>'
    + '</div></div>';

  var thresholdSection = '<div class="settings-section" data-section="thresholds">'
    + '<button class="settings-section-trigger" data-toggle-section="thresholds"><span>Thresholds &amp; Limits</span>' + chevronSvg + '</button>'
    + '<div class="settings-section-body">'
    + '<div class="settings-field-grid grid-3">'
    + '<div class="field-group"><label class="field-label">Free Shipping Threshold ($)</label><input type="number" class="field-input" data-field="free_shipping_threshold" value="' + v('free_shipping_threshold') + '" placeholder="50" /></div>'
    + '<div class="field-group"><label class="field-label">Hot Lead Score</label><input type="number" class="field-input" data-field="lead_hot_score_threshold" value="' + v('lead_hot_score_threshold') + '" placeholder="70" /></div>'
    + '<div class="field-group"><label class="field-label">Churn Risk Threshold</label><input type="number" class="field-input" data-field="churn_risk_threshold" value="' + v('churn_risk_threshold') + '" placeholder="0.7" step="0.1" /></div>'
    + '<div class="field-group"><label class="field-label">ROAS Alert Threshold</label><input type="number" class="field-input" data-field="roas_alert_threshold" value="' + v('roas_alert_threshold') + '" placeholder="2.0" step="0.1" /></div>'
    + '<div class="field-group"><label class="field-label">Winback Stage 2 (days)</label><input type="number" class="field-input" data-field="winback_stage2_days" value="' + v('winback_stage2_days') + '" placeholder="30" /></div>'
    + '<div class="field-group"><label class="field-label">Winback Stage 3 (days)</label><input type="number" class="field-input" data-field="winback_stage3_days" value="' + v('winback_stage3_days') + '" placeholder="60" /></div>'
    + '</div>'
    + '<div class="settings-footer"><span class="dirty-indicator" data-dirty="thresholds">Unsaved changes</span><button class="btn btn-primary btn-sm" data-settings-section="thresholds" disabled>Save changes</button></div>'
    + '</div></div>';

  return '<div class="view-header">'
    + '<div class="view-greeting">Settings</div>'
    + '<div class="view-sub">Configure workspace &amp; workflow preferences</div>'
    + '</div>'
    + '<div class="settings-sections">'
    + brandSection + contactSection + featureSection + thresholdSection
    + '</div>';
}

// ── Settings field map ─────────────────────────────
var SECTION_FIELDS = {
  brand:      ['brand_name', 'store_url', 'brand_voice', 'calendly_url', 'logo_url', 'primary_color'],
  contact:    ['strategy_email', 'ops_email', 'finance_email', 'support_email', 'ceo_phone'],
  features:   ['feature_loyalty', 'feature_gamification', 'feature_rag', 'feature_amazon', 'feature_ugc', 'feature_tax_reports'],
  thresholds: ['free_shipping_threshold', 'lead_hot_score_threshold', 'churn_risk_threshold',
               'roas_alert_threshold', 'winback_stage2_days', 'winback_stage3_days'],
};

// ── Workflow Config Drawer ─────────────────────────

function openWorkflowDrawer(wfId, catColor) {
  closeWorkflowDrawer();

  // Find workflow meta
  var wfMeta = null;
  CATEGORIES.forEach(function (cat) {
    cat.workflows.forEach(function (wf) { if (wf.id === wfId) wfMeta = Object.assign({}, wf, { color: cat.color }); });
  });
  if (!wfMeta) return;

  var color = catColor || wfMeta.color || '#38bdf8';
  var wfState = (state.cache.workflows || []).find(function (w) { return w.workflow_id === wfId; }) || {};
  var overrides = wfState.config_overrides || {};
  var options = WORKFLOW_CONFIG[wfId] || [];
  var outgoing = CASCADE_DISPLAY[wfId] || [];
  var incoming = CASCADE_RECEIVES[wfId] || [];

  // ── Config fields ────────────────────────────────
  var fieldsHtml = options.length
    ? options.map(function (opt) {
        var val = overrides[opt.key] !== undefined ? overrides[opt.key] : opt.default;
        var input = '';
        if (opt.type === 'bool') {
          input = '<label class="toggle-wrap" title="' + esc(opt.label) + '">'
            + '<input type="checkbox" class="toggle-input drawer-field" data-opt-key="' + esc(opt.key) + '" ' + (val ? 'checked' : '') + ' />'
            + '<span class="toggle-track"></span></label>';
        } else if (opt.type === 'select') {
          input = '<select class="field-input drawer-field" data-opt-key="' + esc(opt.key) + '">'
            + (opt.options || []).map(function (o) {
                return '<option value="' + esc(o) + '"' + (val === o ? ' selected' : '') + '>' + esc(o) + '</option>';
              }).join('')
            + '</select>';
        } else {
          input = '<input type="' + (opt.type === 'number' ? 'number' : 'text') + '" class="field-input drawer-field" '
            + 'data-opt-key="' + esc(opt.key) + '" value="' + esc(String(val)) + '" '
            + (opt.type === 'number' ? 'step="any" ' : '') + '/>';
        }
        return '<div class="drawer-field-row">'
          + '<div class="drawer-field-meta"><span class="drawer-field-label">' + esc(opt.label) + '</span>'
          + '<span class="drawer-field-desc">' + esc(opt.desc) + '</span></div>'
          + '<div class="drawer-field-control">' + input + '</div>'
          + '</div>';
      }).join('')
    : '<p class="drawer-empty-note">No configurable options for this workflow.</p>';

  // ── Cascade chain section ────────────────────────
  var chainHtml = '';
  if (outgoing.length || incoming.length) {
    chainHtml = '<div class="drawer-section"><div class="drawer-section-title">Agent Cascade Chain</div>';
    if (incoming.length) {
      chainHtml += '<div class="cascade-chain-group"><span class="cascade-chain-dir">Triggered by</span>'
        + incoming.map(function (c) {
            return '<div class="cascade-chain-item in"><span class="cascade-node">' + esc(c.from) + '</span>'
              + '<span class="cascade-arrow">→</span><span class="cascade-node self">' + esc(wfId) + '</span>'
              + '<span class="cascade-chain-label">' + esc(c.label) + '</span></div>';
          }).join('')
        + '</div>';
    }
    if (outgoing.length) {
      chainHtml += '<div class="cascade-chain-group"><span class="cascade-chain-dir">Triggers downstream</span>'
        + outgoing.map(function (c) {
            return '<div class="cascade-chain-item out"><span class="cascade-node self">' + esc(wfId) + '</span>'
              + '<span class="cascade-arrow">→</span><span class="cascade-node">' + esc(c.to) + '</span>'
              + '<span class="cascade-chain-label">' + esc(c.label) + '</span></div>';
          }).join('')
        + '</div>';
    }
    chainHtml += '</div>';
  }

  // ── Recent cascade log ───────────────────────────
  var recentEvents = cascadeLog.filter(function (e) {
    return e.from === wfId || e.to === wfId || e.workflow_id === wfId;
  }).slice(0, 6);

  var logHtml = recentEvents.length
    ? '<div class="drawer-section"><div class="drawer-section-title">Recent Activity</div>'
      + '<div class="cascade-event-log">'
      + recentEvents.map(function (e) {
          var icon = e.type === 'cascade_start' ? '⚡' : e.type === 'cascade_complete' ? '✓' : e.type === 'cascade_error' ? '✗' : '◉';
          var cls  = e.type === 'cascade_error' ? 'cascade-event-err' : e.type === 'cascade_complete' ? 'cascade-event-ok' : 'cascade-event-info';
          var text = e.label || (e.from ? e.from + ' → ' + e.to : e.workflow_id + ' ' + (e.status || ''));
          return '<div class="cascade-event-row ' + cls + '">'
            + '<span class="cascade-event-icon">' + icon + '</span>'
            + '<span class="cascade-event-text">' + esc(text) + '</span>'
            + '<span class="cascade-event-time">' + timeAgo(e.ts) + '</span>'
            + '</div>';
        }).join('')
      + '</div></div>'
    : '';

  // ── Trigger form ─────────────────────────────────
  var triggerHtml = '<div class="drawer-section"><div class="drawer-section-title">Manual Trigger</div>'
    + '<p class="drawer-trigger-note">Runs this workflow immediately with a test payload. Cascades fire automatically based on the result.</p>'
    + '<div class="drawer-trigger-area" id="trigger-area-' + esc(wfId) + '">'
    + '<div class="trigger-result hidden" id="trigger-result-' + esc(wfId) + '"></div>'
    + '<button class="btn btn-primary" id="trigger-run-btn-' + esc(wfId) + '" data-wf-id="' + esc(wfId) + '">'
    + '<span class="btn-label">Run workflow now</span>'
    + '<span class="btn-spinner hidden">Running…</span>'
    + '</button>'
    + '</div></div>';

  // ── Full drawer HTML ─────────────────────────────
  var drawerHtml = '<div class="wf-drawer" id="wf-drawer">'
    + '<div class="wf-drawer-overlay" id="wf-drawer-overlay"></div>'
    + '<div class="wf-drawer-panel">'
    + '<div class="wf-drawer-header" style="border-top:3px solid ' + esc(color) + '">'
    + '<div style="display:flex;align-items:center;gap:0.75rem">'
    + '<div class="wf-id-badge" style="background:' + hexAlpha(color, 0.15) + ';color:' + esc(color) + ';font-size:0.8rem">' + esc(wfId) + '</div>'
    + '<div><div class="wf-drawer-name">' + esc(wfMeta.name) + '</div>'
    + '<div class="wf-drawer-desc">' + esc(wfMeta.desc) + '</div></div>'
    + '</div>'
    + '<button class="wf-drawer-close" id="wf-drawer-close" title="Close">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="20" height="20"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    + '</button>'
    + '</div>'
    + '<div class="wf-drawer-body">'
    + chainHtml
    + '<div class="drawer-section"><div class="drawer-section-title">Configuration'
    + '<button class="btn btn-primary btn-xs" id="drawer-save-btn" data-wf-id="' + esc(wfId) + '" style="margin-left:auto">Save</button>'
    + '</div>'
    + '<div class="drawer-fields">' + fieldsHtml + '</div>'
    + '</div>'
    + triggerHtml
    + logHtml
    + '</div>'
    + '</div>'
    + '</div>';

  var container = document.createElement('div');
  container.innerHTML = drawerHtml;
  document.body.appendChild(container);

  // Animate in
  requestAnimationFrame(function () {
    var panel = document.querySelector('.wf-drawer-panel');
    if (panel) panel.classList.add('open');
  });

  // Live cascade feed into the log
  var offFeed = onCascadeEvent(function (event) {
    if (event.from !== wfId && event.to !== wfId && event.workflow_id !== wfId) return;
    var logEl = document.querySelector('.cascade-event-log');
    if (!logEl) return;
    var icon = event.type === 'cascade_start' ? '⚡' : event.type === 'cascade_complete' ? '✓' : event.type === 'cascade_error' ? '✗' : '◉';
    var cls  = event.type === 'cascade_error' ? 'cascade-event-err' : event.type === 'cascade_complete' ? 'cascade-event-ok' : 'cascade-event-info';
    var text = event.label || (event.from ? event.from + ' → ' + event.to : (event.workflow_id || '') + ' ' + (event.status || ''));
    var row = document.createElement('div');
    row.className = 'cascade-event-row ' + cls + ' cascade-event-new';
    row.innerHTML = '<span class="cascade-event-icon">' + icon + '</span>'
      + '<span class="cascade-event-text">' + esc(text) + '</span>'
      + '<span class="cascade-event-time">Just now</span>';
    logEl.prepend(row);
    setTimeout(function () { row.classList.remove('cascade-event-new'); }, 600);
    if (logEl.children.length > 8) logEl.lastElementChild.remove();
  });

  // Ensure log section exists for live events
  if (!recentEvents.length) {
    var body = document.querySelector('.wf-drawer-body');
    var logSection = document.createElement('div');
    logSection.className = 'drawer-section';
    logSection.id = 'drawer-log-section-' + wfId;
    logSection.innerHTML = '<div class="drawer-section-title">Recent Activity</div>'
      + '<div class="cascade-event-log"></div>';
    body.appendChild(logSection);
  }

  // Close handlers
  function doClose() { offFeed(); closeWorkflowDrawer(); }
  document.getElementById('wf-drawer-close').addEventListener('click', doClose);
  document.getElementById('wf-drawer-overlay').addEventListener('click', doClose);

  // Save config
  document.getElementById('drawer-save-btn').addEventListener('click', function () {
    var id = this.dataset.wfId;
    var panel = document.querySelector('.wf-drawer-panel');
    var newOverrides = {};
    panel.querySelectorAll('.drawer-field').forEach(function (inp) {
      var key = inp.dataset.optKey;
      if (!key) return;
      if (inp.type === 'checkbox') { newOverrides[key] = inp.checked; }
      else if (inp.type === 'number') { newOverrides[key] = parseFloat(inp.value); }
      else { newOverrides[key] = inp.value; }
    });
    saveWorkflowOverrides(id, newOverrides);
  });

  // Trigger run
  document.getElementById('trigger-run-btn-' + wfId).addEventListener('click', function () {
    runWorkflowTrigger(wfId);
  });
}

function closeWorkflowDrawer() {
  var drawer = document.getElementById('wf-drawer');
  if (!drawer) return;
  var panel = drawer.querySelector('.wf-drawer-panel');
  if (panel) {
    panel.classList.remove('open');
    setTimeout(function () { drawer.remove(); }, 280);
  } else {
    drawer.remove();
  }
}

async function saveWorkflowOverrides(wfId, overrides) {
  var btn = document.getElementById('drawer-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await api('/api/tenants/' + encodeURIComponent(state.slug) + '/workflows/' + encodeURIComponent(wfId), {
      method: 'PATCH',
      body: JSON.stringify({ config_overrides: overrides }),
    });
    // Update cache
    var wf = (state.cache.workflows || []).find(function (w) { return w.workflow_id === wfId; });
    if (wf) wf.config_overrides = overrides;
    toast(wfId + ' settings saved', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function runWorkflowTrigger(wfId) {
  var btn     = document.getElementById('trigger-run-btn-' + wfId);
  var resultEl = document.getElementById('trigger-result-' + wfId);
  if (!btn) return;

  var labelEl  = btn.querySelector('.btn-label');
  var spinnerEl = btn.querySelector('.btn-spinner');
  btn.disabled = true;
  if (labelEl)  labelEl.classList.add('hidden');
  if (spinnerEl) spinnerEl.classList.remove('hidden');
  if (resultEl) resultEl.classList.add('hidden');

  try {
    var data = await api(
      '/api/tenants/' + encodeURIComponent(state.slug) + '/workflows/' + encodeURIComponent(wfId) + '/trigger',
      { method: 'POST', body: JSON.stringify({ payload: {} }) }
    );
    if (resultEl) {
      resultEl.className = 'trigger-result trigger-result-ok';
      resultEl.textContent = 'Completed: ' + JSON.stringify(data.result || data, null, 2).slice(0, 300);
      resultEl.classList.remove('hidden');
    }
    // Refresh workflow stats after run
    delete state.cache.workflows;
    toast(wfId + ' ran successfully', 'success');
  } catch (err) {
    if (resultEl) {
      resultEl.className = 'trigger-result trigger-result-err';
      resultEl.textContent = 'Error: ' + err.message;
      resultEl.classList.remove('hidden');
    }
    toast(wfId + ' run failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    if (labelEl)  labelEl.classList.remove('hidden');
    if (spinnerEl) spinnerEl.classList.add('hidden');
  }
}

// ── Toggle workflow ────────────────────────────────
async function toggleWorkflow(wfId, isActive) {
  // Optimistic update
  if (state.cache.workflows) {
    var wf = state.cache.workflows.find(function (w) { return w.workflow_id === wfId; });
    if (wf) wf.is_active = isActive;
  }
  try {
    await api('/api/tenants/' + encodeURIComponent(state.slug) + '/workflows/' + encodeURIComponent(wfId), {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive }),
    });
    toast(wfId + ' ' + (isActive ? 'enabled' : 'disabled'), 'success');
  } catch (err) {
    // Revert cache
    if (state.cache.workflows) {
      var wfR = state.cache.workflows.find(function (w) { return w.workflow_id === wfId; });
      if (wfR) wfR.is_active = !isActive;
    }
    // Revert DOM
    var inp = document.querySelector('.toggle-input[data-wf-id="' + wfId.replace(/"/g, '\\"') + '"]');
    if (inp) inp.checked = !isActive;
    toast('Failed to toggle ' + wfId + ': ' + err.message, 'error');
  }
}

// ── Save config section ────────────────────────────
async function saveConfig(section, sectionEl) {
  var fields = SECTION_FIELDS[section] || [];
  var updates = {};
  fields.forEach(function (field) {
    var inp = sectionEl.querySelector('[data-field="' + field + '"]');
    if (!inp) return;
    if (inp.type === 'checkbox') {
      updates[field] = inp.checked;
    } else if (inp.type === 'number') {
      var val = inp.value.trim();
      if (val !== '') updates[field] = parseFloat(val);
    } else {
      var strVal = inp.value.trim();
      if (strVal !== '') updates[field] = strVal;
    }
  });

  if (Object.keys(updates).length === 0) {
    toast('No fields to update', 'error');
    return;
  }

  var btn = sectionEl.querySelector('[data-settings-section="' + section + '"]');
  var labelEl = btn && btn.querySelector('.btn-label');
  if (btn) {
    btn.disabled = true;
    if (labelEl) labelEl.textContent = 'Saving...';
    else btn.textContent = 'Saving...';
  }

  try {
    var result = await api('/api/tenants/' + encodeURIComponent(state.slug) + '/config', {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    Object.assign(state.config, result);
    var dirtyEl = sectionEl.querySelector('[data-dirty="' + section + '"]');
    if (dirtyEl) dirtyEl.classList.remove('visible');
    if (btn) {
      btn.disabled = true;
      if (labelEl) labelEl.textContent = 'Save changes';
      else btn.textContent = 'Save changes';
    }
    toast('Settings saved', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
    if (btn) {
      btn.disabled = false;
      if (labelEl) labelEl.textContent = 'Save changes';
      else btn.textContent = 'Save changes';
    }
  }
}

// ── Onboard submit ─────────────────────────────────
async function submitOnboard(formEl) {
  var slug = formEl.querySelector('#ob-slug').value.trim();
  var name = formEl.querySelector('#ob-name').value.trim();
  var plan = formEl.querySelector('#ob-plan').value;

  if (!slug || !name) {
    toast('Workspace slug and client name are required', 'error');
    return;
  }

  var brand = {};

  var brandName = formEl.querySelector('#ob-brand-name').value.trim();
  if (brandName) brand.brand_name = brandName;

  var storeUrl = formEl.querySelector('#ob-store-url').value.trim();
  if (storeUrl) brand.store_url = storeUrl;

  var shopifyDomain = formEl.querySelector('#ob-shopify-domain').value.trim();
  if (shopifyDomain) brand.shopify_shop_domain = shopifyDomain;

  var shopifyToken = formEl.querySelector('#ob-shopify-token').value.trim();
  if (shopifyToken) brand.shopify_access_token = shopifyToken;

  var calendly = formEl.querySelector('#ob-calendly').value.trim();
  if (calendly) brand.calendly_url = calendly;

  var shipping = formEl.querySelector('#ob-shipping').value.trim();
  if (shipping) brand.free_shipping_threshold = parseFloat(shipping);

  var strategyEmail = formEl.querySelector('#ob-strategy-email').value.trim();
  if (strategyEmail) brand.strategy_email = strategyEmail;

  var opsEmail = formEl.querySelector('#ob-ops-email').value.trim();
  if (opsEmail) brand.ops_email = opsEmail;

  var financeEmail = formEl.querySelector('#ob-finance-email').value.trim();
  if (financeEmail) brand.finance_email = financeEmail;

  var ceoPhone = formEl.querySelector('#ob-ceo-phone').value.trim();
  if (ceoPhone) brand.ceo_phone = ceoPhone;

  // Feature flags
  formEl.querySelectorAll('.flag-card input[type="checkbox"]').forEach(function (cb) {
    brand[cb.name] = cb.checked;
  });

  var body = { tenantSlug: slug, tenantName: name, plan: plan, brand: brand };

  var btn = document.getElementById('onboard-submit-btn');
  var labelEl = btn.querySelector('.btn-label');
  var spinnerEl = btn.querySelector('.btn-spinner');
  btn.disabled = true;
  if (labelEl) labelEl.classList.add('hidden');
  if (spinnerEl) spinnerEl.classList.remove('hidden');

  try {
    var result = await api('/api/onboard', { method: 'POST', body: JSON.stringify(body) });
    renderOnboardResult(result);
    formEl.classList.add('hidden');
  } catch (err) {
    toast('Provisioning failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    if (labelEl) labelEl.classList.remove('hidden');
    if (spinnerEl) spinnerEl.classList.add('hidden');
  }
}

function renderOnboardResult(result) {
  var container = document.getElementById('onboard-result');
  container.classList.remove('hidden');

  var tenant      = result.tenant      || {};
  var webhookUrls = result.webhook_urls || {};
  var nextSteps   = result.next_steps   || [];

  var webhookItems = Object.keys(webhookUrls).map(function (key) {
    return '<div class="webhook-item">'
      + '<span class="webhook-key">' + esc(key) + '</span>'
      + '<span class="webhook-url">' + esc(webhookUrls[key]) + '</span>'
      + '</div>';
  }).join('');

  var nextStepsHtml = nextSteps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');

  var planClass = 'plan-' + esc((tenant.plan || 'growth').toLowerCase());

  container.innerHTML = '<div class="onboard-result-header">'
    + '<div class="onboard-result-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg></div>'
    + '<div><h2>Workspace provisioned!</h2>'
    + '<div style="margin-top:4px;display:flex;align-items:center;gap:8px">'
    + '<span style="font-size:0.875rem;color:var(--text-3)">' + esc(tenant.slug) + '</span>'
    + '<span class="plan-pill ' + planClass + '">' + esc(tenant.plan || 'growth') + '</span>'
    + '</div></div></div>'
    + (webhookItems ? '<div class="webhook-section-title">Webhook URLs</div><div class="webhook-list">' + webhookItems + '</div>' : '')
    + (nextStepsHtml ? '<div class="webhook-section-title" style="margin-top:1rem">Next Steps</div><ul class="next-steps-list">' + nextStepsHtml + '</ul>' : '')
    + '<div style="display:flex;gap:0.75rem;margin-top:1.5rem">'
    + '<button class="btn btn-primary" id="result-connect-btn" data-slug="' + esc(tenant.slug) + '">Connect to this workspace</button>'
    + '<button class="btn btn-ghost" id="result-new-btn">Provision another</button>'
    + '</div>';

  document.getElementById('result-connect-btn').addEventListener('click', function () {
    document.getElementById('inp-slug').value = this.dataset.slug;
    document.getElementById('inp-key').value  = state.key || '';
    showScreen('screen-connect');
  });

  document.getElementById('result-new-btn').addEventListener('click', function () {
    document.getElementById('onboard-form').reset();
    document.getElementById('onboard-form').classList.remove('hidden');
    container.classList.add('hidden');
    container.innerHTML = '';
  });
}

// ── View listener attachment ───────────────────────
function attachViewListeners(view, container) {
  if (view === 'workflows') {
    // Toggle on/off
    container.addEventListener('change', function (e) {
      var inp = e.target.closest ? e.target.closest('.toggle-input[data-wf-id]') : null;
      if (!inp && e.target.classList && e.target.classList.contains('toggle-input') && e.target.dataset.wfId) {
        inp = e.target;
      }
      if (inp && inp.dataset.wfId) {
        toggleWorkflow(inp.dataset.wfId, inp.checked);
      }
    });

    // Configure button → open drawer
    container.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.wf-configure-btn') : null;
      if (!btn && e.target.classList && e.target.classList.contains('wf-configure-btn')) btn = e.target;
      if (btn && btn.dataset.wfId) {
        openWorkflowDrawer(btn.dataset.wfId, btn.dataset.catColor);
        return;
      }

      // Run now button → trigger immediately
      var runBtn = e.target.closest ? e.target.closest('.wf-trigger-btn') : null;
      if (!runBtn && e.target.classList && e.target.classList.contains('wf-trigger-btn')) runBtn = e.target;
      if (runBtn && runBtn.dataset.wfId) {
        runWorkflowTrigger(runBtn.dataset.wfId);
      }
    });
  }
  if (view === 'settings') {
    attachSettingsListeners(container);
  }
}

function attachSettingsListeners(container) {
  // Collapsible toggles
  container.querySelectorAll('[data-toggle-section]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sectionEl = btn.closest('.settings-section');
      if (sectionEl) sectionEl.classList.toggle('open');
    });
  });

  // Dirty tracking on inputs
  function markDirty(inp) {
    var sectionEl = inp.closest('[data-section]');
    if (!sectionEl) return;
    var section = sectionEl.dataset.section;
    var dirtyEl = sectionEl.querySelector('[data-dirty="' + section + '"]');
    if (dirtyEl) dirtyEl.classList.add('visible');
    var saveBtn = sectionEl.querySelector('[data-settings-section="' + section + '"]');
    if (saveBtn) saveBtn.disabled = false;
  }

  container.querySelectorAll('[data-field]').forEach(function (inp) {
    inp.addEventListener('input',  function () { markDirty(inp); });
    inp.addEventListener('change', function () { markDirty(inp); });
  });

  // Save buttons
  container.querySelectorAll('[data-settings-section]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var section = btn.dataset.settingsSection;
      var sectionEl = container.querySelector('[data-section="' + section + '"]');
      if (sectionEl) saveConfig(section, sectionEl);
    });
  });
}

// ── Boot ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {

  // Sidebar nav
  document.getElementById('sidebar-nav').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-view]') : null;
    if (!btn && e.target.dataset && e.target.dataset.view) btn = e.target;
    if (btn && btn.dataset.view) go(btn.dataset.view);
  });

  // Connect form
  document.getElementById('connect-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var slugVal = document.getElementById('inp-slug').value.trim();
    var keyVal  = document.getElementById('inp-key').value.trim();
    var errEl   = document.getElementById('connect-error');
    var btn     = document.getElementById('connect-btn');
    var labelEl = btn.querySelector('.btn-label');
    var spinEl  = btn.querySelector('.btn-spinner');

    if (!slugVal || !keyVal) {
      errEl.textContent = 'Please enter both slug and access key.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    btn.disabled = true;
    if (labelEl) labelEl.classList.add('hidden');
    if (spinEl)  spinEl.classList.remove('hidden');

    try {
      await connect(slugVal, keyVal);
    } catch (err) {
      var msg = err.message;
      if (msg.indexOf('404') !== -1) msg = 'Workspace not found. Check your slug.';
      else if (msg.indexOf('401') !== -1) msg = 'Invalid access key.';
      else msg = 'Connection failed: ' + msg;
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      if (labelEl) labelEl.classList.remove('hidden');
      if (spinEl)  spinEl.classList.add('hidden');
    }
  });

  // Go to onboard screen
  document.getElementById('btn-goto-onboard').addEventListener('click', function () {
    showScreen('screen-onboard');
  });

  // Demo mode
  document.getElementById('btn-demo').addEventListener('click', function () {
    connectDemo();
  });

  // Back to connect
  document.getElementById('btn-back-connect').addEventListener('click', function () {
    showScreen('screen-connect');
  });

  // Onboard form
  document.getElementById('onboard-form').addEventListener('submit', function (e) {
    e.preventDefault();
    submitOnboard(e.target);
  });

  // New client button (from sidebar)
  document.getElementById('btn-new-client').addEventListener('click', function () {
    var form = document.getElementById('onboard-form');
    var resultEl = document.getElementById('onboard-result');
    form.reset();
    form.classList.remove('hidden');
    resultEl.classList.add('hidden');
    resultEl.innerHTML = '';
    showScreen('screen-onboard');
  });

  // Disconnect
  document.getElementById('btn-disconnect').addEventListener('click', function () {
    if (window.confirm('Disconnect from this workspace?')) disconnect();
  });
});
