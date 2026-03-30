/**
 * D2C AI Infrastructure — Shared Email Utility
 *
 * Replaces the 7 duplicate Brevo/sendInBlue nodes across workflows.
 * Provides typed send functions for each email type.
 *
 * All emails are tenant-branded using tenant_config values.
 */

'use strict';

const axios = require('axios');

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

/**
 * Base send function.
 * @param {object} params
 */
async function sendEmail({ from, fromName, to, subject, html, text }) {
  const payload = {
    sender:      { email: from || process.env.BREVO_FROM_EMAIL, name: fromName || 'D2C AI' },
    to:          Array.isArray(to) ? to.map(e => ({ email: e })) : [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
  };

  const { data } = await axios.post(BREVO_API, payload, {
    headers: {
      'api-key':      process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
  });
  return data;
}

// ──────────────────────────────────────────────
// Named email functions (one per use-case)
// ──────────────────────────────────────────────

/** A-02: Cold outreach email */
async function sendColdEmail({ tenantConfig, to, name, subject, body }) {
  return sendEmail({
    from:     tenantConfig.sender_email || process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to,
    subject,
    html: `<p>Hi ${name},</p><p>${body}</p><p>Best regards,<br>${tenantConfig.brand_name}</p>`,
  });
}

/** C-01: Cart recovery email */
async function sendCartRecoveryEmail({ tenantConfig, to, cartValue, incentive, checkoutUrl }) {
  const incentiveHtml = incentive && incentive !== 'none'
    ? `<p><strong>Special offer: ${incentive} off your order!</strong></p>`
    : '';

  return sendEmail({
    from:     process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to,
    subject:  `You left something behind…`,
    html: `
      <h2>Complete Your Purchase</h2>
      <p>Hi there!</p>
      <p>You left <strong>$${cartValue}</strong> worth of items in your cart.</p>
      ${incentiveHtml}
      <p><a href="${checkoutUrl || tenantConfig.store_url + '/checkout'}">Complete Purchase →</a></p>
    `,
  });
}

/** C-02: Inventory / launch notification email */
async function sendInventoryEmail({ tenantConfig, toList, subject, message, productId, stockLevel }) {
  return sendEmail({
    from:     process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to:       toList,
    subject,
    html: `
      <h2>${message}</h2>
      <p>Only <strong>${stockLevel}</strong> units available.</p>
      <p><a href="${tenantConfig.store_url}/products/${productId}">Shop Now →</a></p>
    `,
  });
}

/** R-01: Order confirmation / welcome email */
async function sendWelcomeEmail({ tenantConfig, to, firstName, segment, nextCampaign }) {
  return sendEmail({
    from:     process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to,
    subject:  `Thanks for your order, ${firstName}!`,
    html: `
      <h2>Thank you for your order!</h2>
      <p>Hi ${firstName},</p>
      <p>We've received your order and it's being processed.</p>
      <p>As a <strong>${segment}</strong> customer, you'll get exclusive updates!</p>
    `,
  });
}

/** R-02: Loyalty tier upgrade email */
async function sendTierUpgradeEmail({ tenantConfig, to, newTier, discount, pointsBalance }) {
  return sendEmail({
    from:     process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to,
    subject:  `🎉 You've been upgraded to ${newTier.toUpperCase()}!`,
    html: `
      <h2>Congratulations!</h2>
      <p>You've been upgraded to <strong>${newTier.toUpperCase()}</strong> tier!</p>
      <p>Your new benefits include <strong>${discount}% discount</strong> on all orders.</p>
      <p>Points balance: <strong>${pointsBalance}</strong></p>
      <p><a href="${tenantConfig.store_url}">Shop Now →</a></p>
    `,
  });
}

/** R-04: Winback email */
async function sendWinbackEmail({ tenantConfig, to, firstName, message, incentive }) {
  const incentiveHtml = incentive && incentive !== 'personal note'
    ? `<p><strong>Special offer: ${incentive}</strong></p>`
    : '';

  return sendEmail({
    from:     process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to,
    subject:  `We miss you, ${firstName}!`,
    html: `
      <p>Hi ${firstName},</p>
      <p>${message}</p>
      ${incentiveHtml}
      <p><a href="${tenantConfig.store_url}">Shop Now →</a></p>
    `,
  });
}

/** SC-03: High-intent sales follow-up */
async function sendSalesFollowUp({ tenantConfig, to, message, calendlyUrl }) {
  return sendEmail({
    from:     process.env.BREVO_FROM_EMAIL,
    fromName: tenantConfig.brand_name,
    to,
    subject:  `Let's chat about your needs`,
    html: `
      <p>Hi there,</p>
      <p>${message}</p>
      <p>I'd love to show you how we can help.<br>
         <a href="${calendlyUrl || tenantConfig.calendly_url}">Book a quick 15-min call →</a>
      </p>
    `,
  });
}

module.exports = {
  sendEmail,
  sendColdEmail,
  sendCartRecoveryEmail,
  sendInventoryEmail,
  sendWelcomeEmail,
  sendTierUpgradeEmail,
  sendWinbackEmail,
  sendSalesFollowUp,
};
