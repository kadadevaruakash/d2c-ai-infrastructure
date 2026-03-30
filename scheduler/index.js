const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

// Workflow runners
const { runColdEmailCampaign } = require('../workflows/acquire/a02-cold-email');
const { runSeoContentGeneration } = require('../workflows/acquire/a04-seo-content');
const { processDueRecoveries } = require('../workflows/convert/c01-cart-recovery');
const { runAmazonPdpOptimization } = require('../workflows/convert/c03-amazon-pdp');
const { runCompetitorTracker } = require('../workflows/intelligence/i01-competitor-tracker');
const { runRevenueReports } = require('../workflows/intelligence/i02-revenue-reports');
const { runTaxCompliance } = require('../workflows/intelligence/i04-tax-compliance');
const { runSocialAutoPost } = require('../workflows/retain/r03-social-auto');
const { runWinbackCampaign } = require('../workflows/retain/r04-winback');
const { runReviewAlerts } = require('../workflows/support/s03-review-alerts');
const { runUgcCollector } = require('../workflows/scale/sc01-ugc-collector');
const { runFunnelAnalytics } = require('../workflows/scale/sc02-funnel-analytics');

async function getActiveTenants() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return []; // Env vars not configured — skip scheduled runs silently
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await sb
    .from('tenants')
    .select('id, slug, config')
    .eq('active', true);

  if (error) {
    console.error('[Scheduler] Failed to fetch tenants:', error.message);
    return [];
  }
  return data || [];
}

async function runForAllTenants(name, fn) {
  const tenants = await getActiveTenants();
  for (const tenant of tenants) {
    try {
      const config = typeof tenant.config === 'string' ? JSON.parse(tenant.config) : (tenant.config || {});
      await fn(tenant.id, config);
    } catch (err) {
      console.error(`[Scheduler] ${name} failed for tenant ${tenant.slug}:`, err.message);
    }
  }
}

function initScheduler() {
  console.log('[Scheduler] Initializing cron jobs...');

  // Every 15 minutes — Review Alerts
  cron.schedule('*/15 * * * *', () => {
    console.log('[Scheduler] Running: review-alerts');
    runForAllTenants('review-alerts', runReviewAlerts);
  });

  // Every hour — Cart Recovery (process due jobs)
  cron.schedule('0 * * * *', () => {
    console.log('[Scheduler] Running: cart-recovery');
    runForAllTenants('cart-recovery', processDueRecoveries);
  });

  // Every 6 hours — UGC Collector
  cron.schedule('0 */6 * * *', () => {
    console.log('[Scheduler] Running: ugc-collector');
    runForAllTenants('ugc-collector', runUgcCollector);
  });

  // Daily at 7:00 AM — Competitor Tracker
  cron.schedule('0 7 * * *', () => {
    console.log('[Scheduler] Running: competitor-tracker');
    runForAllTenants('competitor-tracker', runCompetitorTracker);
  });

  // Daily at 8:00 AM — Revenue Reports
  cron.schedule('0 8 * * *', () => {
    console.log('[Scheduler] Running: revenue-reports');
    runForAllTenants('revenue-reports', runRevenueReports);
  });

  // Daily at 8:00 AM — Funnel Analytics
  cron.schedule('0 8 * * *', () => {
    console.log('[Scheduler] Running: funnel-analytics');
    runForAllTenants('funnel-analytics', runFunnelAnalytics);
  });

  // Daily at 9:00 AM — Cold Email Campaign
  cron.schedule('0 9 * * *', () => {
    console.log('[Scheduler] Running: cold-email');
    runForAllTenants('cold-email', runColdEmailCampaign);
  });

  // Daily at 9:00 AM — Winback Campaign
  cron.schedule('0 9 * * *', () => {
    console.log('[Scheduler] Running: winback');
    runForAllTenants('winback', runWinbackCampaign);
  });

  // Social auto-post — 10 AM, 2 PM, 6 PM
  cron.schedule('0 10,14,18 * * *', () => {
    console.log('[Scheduler] Running: social-auto-post');
    runForAllTenants('social-auto-post', runSocialAutoPost);
  });

  // Weekly Monday 6:00 AM — SEO Content Generation
  cron.schedule('0 6 * * 1', () => {
    console.log('[Scheduler] Running: seo-content');
    runForAllTenants('seo-content', runSeoContentGeneration);
  });

  // Weekly Monday 8:00 AM — Amazon PDP Optimization
  cron.schedule('0 8 * * 1', () => {
    console.log('[Scheduler] Running: amazon-pdp');
    runForAllTenants('amazon-pdp', runAmazonPdpOptimization);
  });

  // Monthly 1st at 9:00 AM — Tax Compliance
  cron.schedule('0 9 1 * *', () => {
    console.log('[Scheduler] Running: tax-compliance');
    runForAllTenants('tax-compliance', runTaxCompliance);
  });

  console.log('[Scheduler] All cron jobs registered.');
}

module.exports = { initScheduler };
