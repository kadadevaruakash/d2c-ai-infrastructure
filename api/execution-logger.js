'use strict';

const { createClient } = require('@supabase/supabase-js');

async function logExecution(tenantId, workflowId, status, durationMs, inputPayload, outputPayload, errorMessage) {
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await sb.from('workflow_execution_logs').insert({
      tenant_id:       tenantId,
      workflow_id:     workflowId,
      status,
      duration_ms:     durationMs || null,
      input_summary:   buildInputSummary(workflowId, inputPayload),
      output_summary:  buildOutputSummary(workflowId, outputPayload, errorMessage),
      error_message:   errorMessage || null,
      input_payload:   inputPayload  || null,
      output_payload:  outputPayload || null,
    });
  } catch (err) {
    console.warn('[ExecutionLogger] Failed to log:', err.message);
  }
}

function buildInputSummary(wfId, p) {
  if (!p) return 'No payload';
  if (wfId === 'A-01') return `${p.name || 'Unknown'} — ${p.email || ''}`;
  if (wfId === 'A-02') return `Prospect: ${p.name || p.email || 'unknown'}`;
  if (wfId === 'C-01') return `${p.customer?.email || p.email || 'Customer'} — cart £${p.total_price || '?'}`;
  if (wfId === 'C-04') return `Checkout started — cart £${p.total_price || '?'}`;
  if (wfId === 'R-01') return `Order #${p.id || p.order_id || '?'}`;
  if (wfId === 'R-02') return `Event: ${p.event_type || '?'} — ${p.customer_email || ''}`;
  if (wfId === 'S-01') return `WhatsApp from ${p.from || 'unknown'}`;
  if (wfId === 'S-02') return `"${String(p.query || p.message || '').slice(0, 60)}"`;
  if (wfId === 'I-02') return 'Daily revenue run';
  if (wfId === 'SC-04') return `New product: ${p.title || '?'}`;
  return JSON.stringify(p).slice(0, 80);
}

function buildOutputSummary(wfId, o, error) {
  if (error) return `Error: ${String(error).slice(0, 100)}`;
  if (!o) return 'Completed';
  if (o.email_sent)       return 'Email sent';
  if (o.classification)   return `Classified: ${o.classification}, score ${o.score}`;
  if (o.points_awarded)   return `${o.points_awarded} points awarded`;
  if (o.answer)           return o.answer.slice(0, 100);
  if (o.message)          return String(o.message).slice(0, 100);
  return 'Completed successfully';
}

module.exports = { logExecution };
