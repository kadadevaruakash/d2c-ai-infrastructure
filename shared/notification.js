/**
 * D2C AI Infrastructure — Centralized Notification Service
 *
 * Replaces the 24 duplicated Slack nodes across all workflows.
 * Single entry point for all outbound notifications (Slack, email alerts).
 *
 * How to use in n8n:
 *   Replace each workflow's Slack node with a single HTTP Request node that calls:
 *   POST {{ $env.N8N_BASE_URL }}/api/notify
 *   Body: { tenantSlug, channel, message, level, metadata }
 *
 * The /api/notify endpoint calls this module.
 */

'use strict';

const { WebClient } = require('@slack/web-api');

// ──────────────────────────────────────────────
// Slack notifier
// ──────────────────────────────────────────────

class NotificationService {
  constructor() {
    this._slackClient = null;
  }

  _getSlack() {
    if (!this._slackClient) {
      this._slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    }
    return this._slackClient;
  }

  /**
   * Send a Slack message to a channel.
   * @param {string} channel      - Slack channel name e.g. '#leads'
   * @param {string} message      - Message text (supports Slack mrkdwn)
   * @param {string} [level]      - 'info' | 'warning' | 'error' | 'success'
   */
  async slack(channel, message, level = 'info') {
    const levelEmoji = { info: 'ℹ️', warning: '⚠️', error: '🚨', success: '✅' };
    const prefix = levelEmoji[level] || '';
    const text = prefix ? `${prefix} ${message}` : message;

    try {
      await this._getSlack().chat.postMessage({
        channel,
        text,
        mrkdwn: true,
      });
    } catch (err) {
      console.error(`[notify] Slack error on channel ${channel}:`, err.message);
    }
  }

  /**
   * Send a critical email alert using Brevo transactional API.
   * @param {object} params
   * @param {string} params.to       - Recipient email
   * @param {string} params.subject  - Email subject
   * @param {string} params.body     - Plain text body
   */
  async emailAlert({ to, subject, body }) {
    const axios = require('axios');
    try {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: { email: process.env.BREVO_FROM_EMAIL, name: process.env.BREVO_FROM_NAME || 'D2C AI' },
          to: [{ email: to }],
          subject,
          textContent: body,
        },
        {
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (err) {
      console.error('[notify] Email alert error:', err.message);
    }
  }

  /**
   * Route a notification based on workflow, level, and tenant config.
   * This is the single entry point called by /api/notify.
   *
   * @param {object} tenantConfig  - Row from tenant_config table
   * @param {string} channelKey    - Key from slack_channels in brand config
   *                                 e.g. 'hot_leads', 'revenue', 'support'
   * @param {string} message       - Notification text
   * @param {string} level         - 'info' | 'warning' | 'error' | 'success'
   * @param {object} [emailOpts]   - If set, also sends email alert
   */
  async notify(tenantConfig, channelKey, message, level = 'info', emailOpts = null) {
    // Map channelKey to the actual channel name from tenant config
    const channelMap = {
      leads:       tenantConfig.slack_channel_leads,
      outreach:    tenantConfig.slack_channel_outreach,
      hot_leads:   tenantConfig.slack_channel_hot_leads,
      content:     tenantConfig.slack_channel_content,
      amazon:      tenantConfig.slack_channel_amazon,
      launches:    tenantConfig.slack_channel_launches,
      analytics:   tenantConfig.slack_channel_analytics,
      revenue:     tenantConfig.slack_channel_revenue,
      crm:         tenantConfig.slack_channel_crm,
      retention:   tenantConfig.slack_channel_retention,
      support:     tenantConfig.slack_channel_support,
      reviews:     tenantConfig.slack_channel_reviews,
      social:      tenantConfig.slack_channel_social,
      ugc:         tenantConfig.slack_channel_ugc,
      incidents:   tenantConfig.slack_channel_incidents,
      seo:         tenantConfig.slack_channel_seo,
      sales:       tenantConfig.slack_channel_sales,
      checkout:    tenantConfig.slack_channel_checkout,
    };

    const channel = channelMap[channelKey] || '#general';

    await this.slack(channel, message, level);

    if (emailOpts) {
      await this.emailAlert(emailOpts);
    }
  }
}

const notifier = new NotificationService();
module.exports = notifier;
