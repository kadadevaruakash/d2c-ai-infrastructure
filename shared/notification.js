'use strict';

/**
 * D2C AI Infrastructure — Centralized Notification Service
 *
 * WhatsApp replaces Slack as the ops notification channel.
 * All 24 workflows route through here instead of calling Slack directly.
 *
 * How to use in any workflow:
 *   const notifier = require('../../shared/notification');
 *   await notifier.notify(config, 'hot_leads', 'New hot lead scored 88/100', 'success');
 *
 * Channel keys map to phone numbers stored in tenant_config.
 * Urgent channels (incidents, escalations) also send to ceo_phone.
 *
 * The /api/notify endpoint calls notifier.notify() — unchanged API,
 * only the transport layer changed (WhatsApp instead of Slack).
 */

const whatsapp = require('./whatsapp');

// ─────────────────────────────────────────────────────────────
// Channel → phone mapping
// ─────────────────────────────────────────────────────────────

// Maps channelKey to one or more phone fields in tenant_config.
// A channel can notify multiple phones (e.g. incidents → ops + ceo).
const CHANNEL_PHONE_MAP = {
  leads:       ['sales_rep_phone'],
  hot_leads:   ['sales_rep_phone', 'sales_lead_phone'],
  outreach:    ['sales_rep_phone'],
  content:     ['content_manager_phone'],
  amazon:      ['ops_phone'],
  launches:    ['content_manager_phone', 'ops_phone'],
  analytics:   ['sales_lead_phone'],
  revenue:     ['ceo_phone'],
  crm:         ['ops_phone'],
  retention:   ['ops_phone'],
  support:     ['ops_phone'],
  reviews:     ['ops_phone', 'ceo_phone'],
  social:      ['content_manager_phone'],
  ugc:         ['content_manager_phone'],
  incidents:   ['ceo_phone', 'ops_phone'],
  seo:         ['content_manager_phone'],
  sales:       ['sales_rep_phone', 'sales_lead_phone'],
  checkout:    ['ops_phone'],
};

// ─────────────────────────────────────────────────────────────
// NotificationService
// ─────────────────────────────────────────────────────────────

class NotificationService {

  /**
   * Send a WhatsApp notification to the phone(s) mapped to channelKey.
   *
   * @param {string} channel  - e.g. '#leads' (legacy Slack format, strip the #)
   * @param {string} message  - Notification text
   * @param {string} level    - 'info' | 'warning' | 'error' | 'success'
   * @param {object} [config] - Tenant config (for phone lookup)
   */
  async whatsapp(channel, message, level = 'info', config = {}) {
    // Strip '#' prefix if passed from legacy Slack-style callers
    const cleanChannel = channel.replace(/^#/, '');
    const phoneKeys    = CHANNEL_PHONE_MAP[cleanChannel] || ['ops_phone'];

    const phones = [...new Set(
      phoneKeys
        .map(k => config[k])
        .filter(Boolean)
    )];

    if (phones.length === 0) {
      // Fallback to ceo_phone if no channel phone is configured
      const fallback = config.ceo_phone;
      if (fallback) phones.push(fallback);
    }

    const sends = phones.map(phone =>
      whatsapp.sendNotify(phone, message, level).catch(err =>
        console.error(`[notify] WhatsApp error to ${phone}:`, err.message)
      )
    );

    await Promise.all(sends);
  }

  /**
   * Send a critical email alert using Brevo transactional API.
   * Kept for backwards compatibility — email alerts are still useful
   * for audit trails and finance/compliance notifications.
   */
  async emailAlert({ to, subject, body }) {
    const axios = require('axios');
    try {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender:      { email: process.env.BREVO_FROM_EMAIL, name: process.env.BREVO_FROM_NAME || 'D2C AI' },
          to:          [{ email: to }],
          subject,
          textContent: body,
        },
        {
          headers: {
            'api-key':      process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (err) {
      console.error('[notify] Email alert error:', err.message);
    }
  }

  /**
   * Route a notification based on channel key and tenant config.
   * This is the single entry point called by POST /api/notify.
   *
   * @param {object} tenantConfig  - Row from tenant_config
   * @param {string} channelKey    - e.g. 'hot_leads', 'revenue', 'incidents'
   * @param {string} message       - Notification text
   * @param {string} level         - 'info' | 'warning' | 'error' | 'success'
   * @param {object} [emailOpts]   - If set, also sends email alert (for compliance channels)
   */
  async notify(tenantConfig, channelKey, message, level = 'info', emailOpts = null) {
    await this.whatsapp(channelKey, message, level, tenantConfig);

    if (emailOpts) {
      await this.emailAlert(emailOpts);
    }
  }

  /**
   * Direct phone notification — bypasses channel mapping.
   * Use when you know the exact recipient.
   *
   * @param {string} phone
   * @param {string} message
   * @param {string} level
   */
  async direct(phone, message, level = 'info') {
    if (!phone) return;
    await whatsapp.sendNotify(phone, message, level);
  }
}

const notifier = new NotificationService();
module.exports = notifier;
