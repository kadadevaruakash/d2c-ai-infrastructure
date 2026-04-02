'use strict';

/**
 * D2C AI Infrastructure — WhatsApp Reply Router
 *
 * This is the "reply brain" of the WhatsApp-first architecture.
 * It intercepts every inbound WhatsApp message and routes it to the
 * correct workflow handler based on a pending-action record stored
 * in Supabase.
 *
 * ── How it works ──────────────────────────────────────────────
 *
 * 1. A workflow (A-01, A-03, A-04, I-03, SC-03, A-02) sends a WA
 *    message to a rep/manager and calls storePendingAction() to
 *    record what reply context is expected.
 *
 * 2. When Meta fires the WhatsApp webhook (POST /webhook/:slug/whatsapp-reply),
 *    routeIncomingReply() is called.
 *
 * 3. The router finds the latest pending action for the sender's phone,
 *    dispatches to the matching handler, marks the action as 'acted',
 *    and sends a confirmation WA back.
 *
 * ── Required Supabase table ────────────────────────────────────
 *
 *   CREATE TABLE whatsapp_pending_actions (
 *     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 *     phone         TEXT NOT NULL,
 *     context_type  TEXT NOT NULL,
 *     context_data  JSONB NOT NULL DEFAULT '{}',
 *     status        TEXT NOT NULL DEFAULT 'pending',
 *     expires_at    TIMESTAMPTZ NOT NULL,
 *     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX ON whatsapp_pending_actions (phone, status);
 *
 * ── Context types ──────────────────────────────────────────────
 *
 *   lead_qualify        → Scenario 1: rep qualifies/passes a hot lead
 *   email_reply_handoff → Scenario 2: rep claims a prospect email reply
 *   ig_reply            → Scenario 3: rep sends text back to Instagram DM
 *   seo_approval        → Scenario 4: manager approves/edits/rejects SEO draft
 *   cold_lead_reengage  → Scenario 5: sales lead re-engages cold lead batch
 *   sales_handoff       → SC-03: rep claims a high-intent inbound signal
 */

const { createClient }  = require('@supabase/supabase-js');
const whatsapp          = require('../shared/whatsapp');

// Lazy-load to avoid circular deps
function getHandlers() {
  return {
    a01: require('../workflows/acquire/a01-lead-capture'),
    a02: require('../workflows/acquire/a02-cold-email'),
    a03: require('../workflows/acquire/a03-ig-dm'),
    a04: require('../workflows/acquire/a04-seo-content'),
    i03: require('../workflows/intelligence/i03-customer-intel'),
    sc03: require('../workflows/scale/sc03-sales-auto'),
  };
}

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─────────────────────────────────────────────────────────────
// Pending action store
// ─────────────────────────────────────────────────────────────

/**
 * Store a pending WA action so the reply router knows what to do
 * when the recipient responds.
 *
 * @param {object} params
 * @param {string}  params.tenantId
 * @param {string}  params.phone         - The phone we sent to (E.164)
 * @param {string}  params.contextType   - See context types above
 * @param {object}  params.contextData   - Workflow-specific data needed to handle the reply
 * @param {number}  [params.ttlHours=24] - How long to keep the action open
 */
async function storePendingAction({ tenantId, phone, contextType, contextData, ttlHours = 24 }) {
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  // Expire any older pending action of same type for this phone (only latest is relevant)
  await sb()
    .from('whatsapp_pending_actions')
    .update({ status: 'expired' })
    .eq('phone', phone)
    .eq('tenant_id', tenantId)
    .eq('context_type', contextType)
    .eq('status', 'pending');

  const { data, error } = await sb()
    .from('whatsapp_pending_actions')
    .insert({
      tenant_id:    tenantId,
      phone,
      context_type: contextType,
      context_data: contextData,
      status:       'pending',
      expires_at:   expiresAt,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[wa-reply-router] Failed to store pending action:', error.message);
    return null;
  }
  return data.id;
}

/**
 * Look up the most recent live pending action for a phone.
 * A phone may have multiple context types outstanding (e.g. a rep has a
 * lead_qualify and a sales_handoff pending). Returns the most recently
 * created one.
 */
async function findPendingAction(phone, tenantId) {
  const { data, error } = await sb()
    .from('whatsapp_pending_actions')
    .select('*')
    .eq('phone', phone)
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

async function markActionActed(actionId) {
  await sb()
    .from('whatsapp_pending_actions')
    .update({ status: 'acted' })
    .eq('id', actionId);
}

// ─────────────────────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Called by the WhatsApp webhook handler in server.js.
 * Parses the incoming message and dispatches to the right handler.
 *
 * @param {string} tenantId
 * @param {object} tenantConfig
 * @param {object} webhookBody  - Raw Meta webhook payload
 */
async function routeIncomingReply(tenantId, tenantConfig, webhookBody) {
  const message = _extractMessage(webhookBody);
  if (!message) return { routed: false, reason: 'no_message' };

  const { from, text, interactive_reply_id } = message;

  // For interactive button replies, use the button ID as the command
  const rawReply = interactive_reply_id || text || '';
  const reply    = rawReply.trim();

  const pending = await findPendingAction(from, tenantId);

  if (!pending) {
    // No pending action — could be an unsolicited message or expired context
    await whatsapp.sendText(from,
      `I don't have a pending request for you right now.\n\nIf you expected a prompt, it may have expired (24h limit). Actions will resend when triggered.`
    );
    return { routed: false, reason: 'no_pending_action', from };
  }

  const handlers = getHandlers();

  let result;

  switch (pending.context_type) {

    case 'lead_qualify':
      result = await _handleLeadQualify(from, reply, pending, tenantId, tenantConfig, handlers);
      break;

    case 'email_reply_handoff':
      result = await _handleEmailReplyHandoff(from, reply, pending, tenantId, tenantConfig, handlers);
      break;

    case 'ig_reply':
      result = await _handleIgReply(from, reply, pending, tenantId, tenantConfig, handlers);
      break;

    case 'seo_approval':
      result = await _handleSeoApproval(from, reply, pending, tenantId, tenantConfig, handlers);
      break;

    case 'cold_lead_reengage':
      result = await _handleColdLeadReengage(from, reply, pending, tenantId, tenantConfig, handlers);
      break;

    case 'sales_handoff':
      result = await _handleSalesHandoff(from, reply, pending, tenantId, tenantConfig, handlers);
      break;

    default:
      await whatsapp.sendText(from, `Unknown action type: ${pending.context_type}`);
      result = { handled: false };
  }

  // Only mark as acted if handler succeeded (allow retry if it crashes)
  if (result?.handled !== false) {
    await markActionActed(pending.id);
  }

  return { routed: true, context_type: pending.context_type, result };
}

// ─────────────────────────────────────────────────────────────
// Context handlers
// ─────────────────────────────────────────────────────────────

/**
 * SCENARIO 1 — lead_qualify
 * Rep receives hot lead card, replies QUALIFY / PASS / INFO
 */
async function _handleLeadQualify(phone, reply, pending, tenantId, tenantConfig, handlers) {
  const { lead_id, email, name, score } = pending.context_data;
  const cmd = reply.toUpperCase().split(' ')[0];

  if (cmd === 'QUALIFY') {
    // Update lead status in Supabase
    await sb().from('leads')
      .update({ status: 'qualified', qualified_at: new Date().toISOString() })
      .eq('id', lead_id)
      .eq('tenant_id', tenantId);

    // Fire SC-03 to start email sequence
    await handlers.sc03.handleSalesSignal(tenantId, {
      name, email, intent: 'high', source: 'lead_qualify_wa',
      signal: `Hot lead scored ${score}/100 — manually qualified by rep`,
    }, tenantConfig);

    await whatsapp.sendText(phone,
      `✅ Lead qualified.\n\n*${name}* (${email}) — Score: ${score}/100\n\nEmail sequence started via SC-03. You'll get a reply alert here if they respond.`
    );
    return { handled: true, action: 'qualified', lead_id };
  }

  if (cmd === 'PASS') {
    await sb().from('leads')
      .update({ status: 'dismissed', dismissed_at: new Date().toISOString() })
      .eq('id', lead_id)
      .eq('tenant_id', tenantId);

    await whatsapp.sendText(phone, `Lead dismissed.\n\n${name} (${email}) has been marked as not a fit.`);
    return { handled: true, action: 'dismissed', lead_id };
  }

  if (cmd === 'INFO') {
    const { data: lead } = await sb().from('leads').select('*').eq('id', lead_id).single();
    const info = lead
      ? `👤 *${lead.name}*\n📧 ${lead.email}\n📞 ${lead.phone || 'n/a'}\n🏢 ${lead.company || 'n/a'}\n📊 Score: ${lead.score}/100\n📍 Source: ${lead.source || 'direct'}\n📝 Notes: ${lead.notes || 'none'}`
      : `Lead #${lead_id} not found.`;
    await whatsapp.sendText(phone, info);
    return { handled: false }; // don't expire — rep may still want to qualify/pass
  }

  // Unrecognised — remind them of the commands
  await whatsapp.sendText(phone,
    `Reply *QUALIFY* to start sequence, *PASS* to dismiss, or *INFO* for full profile.\n\nLead: ${name} (${email})`
  );
  return { handled: false };
}

/**
 * SCENARIO 2 — email_reply_handoff
 * Rep receives alert that a prospect replied to a cold email.
 * Replies CONTACT / ASSIGN / PASS
 */
async function _handleEmailReplyHandoff(phone, reply, pending, tenantId, tenantConfig, handlers) {
  const { prospect_id, prospect_email, prospect_name, reply_text, intent, suggested_opener } = pending.context_data;
  const cmd = reply.toUpperCase().split(' ')[0];

  if (cmd === 'CONTACT') {
    // Create or update lead record
    await sb().from('leads').upsert({
      tenant_id:    tenantId,
      email:        prospect_email,
      name:         prospect_name,
      status:       'contacted',
      source:       'cold_email_reply',
      notes:        `Replied to cold email. Intent: ${intent}. Reply: "${reply_text?.slice(0, 200)}"`,
      score:        intent === 'interested' ? 75 : 55,
      classification: 'warm',
      created_at:   new Date().toISOString(),
    }, { onConflict: 'tenant_id,email' });

    // Update prospect status
    if (prospect_id) {
      await sb().from('prospects')
        .update({ status: 'replied', last_reply_at: new Date().toISOString() })
        .eq('id', prospect_id);
    }

    await whatsapp.sendText(phone,
      `✅ Lead claimed.\n\n*${prospect_name}* (${prospect_email}) moved to your pipeline.\n\nSuggested opener:\n"${suggested_opener}"\n\nCopy and send from your email whenever ready.`
    );
    return { handled: true, action: 'contacted', prospect_id };
  }

  if (cmd === 'ASSIGN') {
    // Notify the ops email about the assignment request
    const notifier = require('../shared/notification');
    const opsPhone = tenantConfig.ops_phone || tenantConfig.ceo_phone;
    if (opsPhone) {
      await whatsapp.sendText(opsPhone,
        `📨 *Assignment Request*\n\n${prospect_name} (${prospect_email}) replied to a cold email.\nIntent: ${intent}\n\nA rep is requesting this be assigned. Check the pipeline.`
      );
    }
    await whatsapp.sendText(phone, `Assignment request sent to ops for ${prospect_name}.`);
    return { handled: true, action: 'assign_requested' };
  }

  if (cmd === 'PASS') {
    if (prospect_id) {
      await sb().from('prospects').update({ status: 'passed' }).eq('id', prospect_id);
    }
    await whatsapp.sendText(phone, `Lead passed. ${prospect_name} will not be followed up.`);
    return { handled: true, action: 'passed' };
  }

  await whatsapp.sendText(phone,
    `Reply *CONTACT* to claim, *ASSIGN* to forward to team, or *PASS* to skip.\n\nLead: ${prospect_name} (${prospect_email})`
  );
  return { handled: false };
}

/**
 * SCENARIO 3 — ig_reply
 * Rep receives IG DM escalation. Their plain-text reply is forwarded to
 * the customer on Instagram via the Graph API.
 */
async function _handleIgReply(phone, reply, pending, tenantId, tenantConfig, handlers) {
  const { ig_sender_id, ig_username, original_message } = pending.context_data;
  const cmd = reply.toUpperCase().trim();

  if (cmd === 'SKIP') {
    await whatsapp.sendText(phone, `Instagram DM from @${ig_username} skipped.`);
    return { handled: true, action: 'skipped' };
  }

  // Forward the rep's message to Instagram
  const sent = await handlers.a03.sendInstagramReply(ig_sender_id, reply, tenantConfig);

  if (sent.ok) {
    // Log the conversation
    await sb().from('ig_conversations').upsert({
      tenant_id:    tenantId,
      ig_sender_id,
      ig_username:  ig_username || 'unknown',
      direction:    'outbound',
      message:      reply,
      created_at:   new Date().toISOString(),
    }, { onConflict: 'tenant_id,ig_sender_id,direction,created_at' }).catch(() => {});

    await whatsapp.sendText(phone,
      `✅ Reply sent to @${ig_username} on Instagram.\n\n"${reply.slice(0, 200)}"`
    );
    return { handled: true, action: 'replied_to_ig', ig_sender_id };
  }

  await whatsapp.sendText(phone,
    `⚠️ Failed to send reply to Instagram: ${sent.error}\n\nPlease reply directly on Instagram.`
  );
  return { handled: false, error: sent.error };
}

/**
 * SCENARIO 4 — seo_approval
 * Content manager approves, edits (with feedback), or rejects an SEO draft.
 */
async function _handleSeoApproval(phone, reply, pending, tenantId, tenantConfig, handlers) {
  const { draft_id, product_id, shopify_product_id } = pending.context_data;
  const upperReply = reply.toUpperCase();

  if (upperReply.startsWith('APPROVE')) {
    const published = await handlers.a04.publishDraft(draft_id, shopify_product_id, tenantConfig);

    if (published.ok) {
      await whatsapp.sendText(phone,
        `✅ Published!\n\n*${published.product_title}* SEO content is live.\n\n🔗 ${tenantConfig.store_url}/products/${published.handle}`
      );
      return { handled: true, action: 'approved_published', draft_id };
    }

    await whatsapp.sendText(phone, `⚠️ Publish failed: ${published.error}\nPlease check Shopify manually.`);
    return { handled: false, error: published.error };
  }

  if (upperReply.startsWith('EDIT ')) {
    const feedback = reply.slice(5).trim(); // everything after "EDIT "
    const regen = await handlers.a04.regenerateDraft(draft_id, feedback, tenantConfig);

    await whatsapp.sendSeoApproval(phone, regen.draft, tenantConfig);

    // Store new pending action for the regenerated draft
    await storePendingAction({
      tenantId,
      phone,
      contextType: 'seo_approval',
      contextData: { draft_id: regen.draft.draft_id, product_id, shopify_product_id },
      ttlHours: 24,
    });

    return { handled: true, action: 'edit_requested', new_draft_id: regen.draft.draft_id };
  }

  if (upperReply.startsWith('REJECT')) {
    await sb().from('seo_content_drafts')
      .update({ status: 'rejected', rejected_at: new Date().toISOString() })
      .eq('id', draft_id);

    await whatsapp.sendText(phone, `Draft rejected and discarded. No changes made to Shopify.`);
    return { handled: true, action: 'rejected', draft_id };
  }

  await whatsapp.sendText(phone,
    `Reply *APPROVE* to publish, *EDIT [your notes]* to regenerate, or *REJECT* to discard.`
  );
  return { handled: false };
}

/**
 * SCENARIO 5 — cold_lead_reengage
 * Sales lead receives digest of cold leads, chooses which segment to re-engage.
 */
async function _handleColdLeadReengage(phone, reply, pending, tenantId, tenantConfig, handlers) {
  const { high_ids, mid_ids, all_ids, top_leads } = pending.context_data;
  const cmd = reply.toUpperCase().trim();

  let targetIds = [];
  let label = '';

  if (cmd === 'RE-ENGAGE ALL') { targetIds = all_ids;  label = 'all'; }
  else if (cmd === 'RE-ENGAGE HIGH') { targetIds = high_ids; label = 'high-value'; }
  else if (cmd === 'RE-ENGAGE MID')  { targetIds = mid_ids;  label = 'mid-value'; }
  else if (cmd === 'SHOW LIST') {
    if (!top_leads || top_leads.length === 0) {
      await whatsapp.sendText(phone, 'No cold leads on record.');
      return { handled: false };
    }
    const lines = top_leads.slice(0, 10).map((l, i) =>
      `${i + 1}. *${l.name}* (${l.email})\n   Score: ${l.score} · Last contact: ${_daysAgo(l.last_contacted_at)}d ago`
    );
    await whatsapp.sendText(phone,
      `📋 *Top Cold Leads*\n\n${lines.join('\n\n')}\n\nReply *RE-ENGAGE ALL*, *RE-ENGAGE HIGH*, or *RE-ENGAGE MID* to launch A-02.`
    );
    return { handled: false }; // keep pending so they can still choose
  }

  if (targetIds.length === 0) {
    await whatsapp.sendText(phone,
      `Reply *RE-ENGAGE ALL*, *RE-ENGAGE HIGH*, *RE-ENGAGE MID*, or *SHOW LIST*.`
    );
    return { handled: false };
  }

  // Fire A-02 batch for selected segment
  const batchResult = await handlers.a02.handleColdEmailBatch(tenantId, {
    lead_ids:   targetIds,
    source:     'cold_lead_reengage',
    campaign:   `Re-engagement: ${label}`,
  }, tenantConfig);

  await whatsapp.sendText(phone,
    `🚀 Re-engagement launched for *${targetIds.length} ${label}* leads.\n\nA-02 email sequence started. You'll get reply alerts here if any respond.`
  );

  return { handled: true, action: 're_engaged', segment: label, count: targetIds.length, batch_result: batchResult };
}

/**
 * SC-03 — sales_handoff
 * Rep receives high-intent inbound lead, replies ASSIGN / EMAIL / PASS
 */
async function _handleSalesHandoff(phone, reply, pending, tenantId, tenantConfig, handlers) {
  const { lead_id, email, name, intent_summary } = pending.context_data;
  const cmd = reply.toUpperCase().split(' ')[0];

  if (cmd === 'ASSIGN') {
    await sb().from('leads')
      .update({ status: 'assigned', assigned_to_phone: phone, assigned_at: new Date().toISOString() })
      .eq('id', lead_id);

    await whatsapp.sendText(phone,
      `✅ Lead assigned to you.\n\n*${name}* (${email})\n\nThey'll receive a personalised follow-up email. Reply alerts come here.`
    );
    return { handled: true, action: 'assigned', lead_id };
  }

  if (cmd === 'EMAIL') {
    // Fire email sequence immediately
    await handlers.sc03.handleSalesSignal(tenantId, {
      name, email, intent: 'high', source: 'sales_handoff_wa',
      signal: intent_summary,
    }, tenantConfig);

    await sb().from('leads').update({ status: 'sequenced' }).eq('id', lead_id);
    await whatsapp.sendText(phone, `📧 Email sequence fired for *${name}* (${email}).`);
    return { handled: true, action: 'emailed', lead_id };
  }

  if (cmd === 'PASS') {
    await sb().from('leads').update({ status: 'passed' }).eq('id', lead_id);
    await whatsapp.sendText(phone, `Lead passed. ${name} will not be contacted.`);
    return { handled: true, action: 'passed', lead_id };
  }

  await whatsapp.sendText(phone,
    `Reply *ASSIGN* to take the lead, *EMAIL* to fire sequence now, or *PASS* to skip.\n\n${name} (${email})`
  );
  return { handled: false };
}

// ─────────────────────────────────────────────────────────────
// Webhook payload parser
// ─────────────────────────────────────────────────────────────

/**
 * Extract the relevant message fields from a Meta WhatsApp webhook payload.
 * Returns null if no actionable message is found (status updates, etc).
 */
function _extractMessage(body) {
  try {
    const entry   = body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message) return null;

    // Ignore delivery/read status updates
    if (message.type === 'status') return null;

    const from = message.from; // E.164 without +

    // Plain text
    if (message.type === 'text') {
      return { from: `+${from}`, text: message.text?.body || '', interactive_reply_id: null };
    }

    // Interactive button reply (button id is the command)
    if (message.type === 'interactive') {
      const btnReply = message.interactive?.button_reply;
      const listReply = message.interactive?.list_reply;
      const id = btnReply?.id || listReply?.id || '';
      const title = btnReply?.title || listReply?.title || '';
      return { from: `+${from}`, text: title, interactive_reply_id: id };
    }

    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function _daysAgo(isoDate) {
  if (!isoDate) return '?';
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

// ─────────────────────────────────────────────────────────────
// Express route handler (called from server.js)
// ─────────────────────────────────────────────────────────────

/**
 * Express middleware that handles POST /webhook/:tenantSlug/whatsapp-reply.
 * Verifies the webhook is from Meta, then dispatches.
 */
async function handleWhatsAppReply(req, res, tenantId, tenantConfig) {
  // Acknowledge immediately — Meta requires 200 within 1s
  res.json({ received: true });

  // Process asynchronously so we don't block Meta's retry logic
  setImmediate(async () => {
    try {
      await routeIncomingReply(tenantId, tenantConfig, req.body);
    } catch (err) {
      console.error('[wa-reply-router] Unhandled error:', err.message);
    }
  });
}

module.exports = {
  storePendingAction,
  findPendingAction,
  markActionActed,
  routeIncomingReply,
  handleWhatsAppReply,
};
