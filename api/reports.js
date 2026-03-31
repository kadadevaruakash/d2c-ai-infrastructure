'use strict';

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }

// GET /api/tenants/:slug/reports/monthly?month=YYYY-MM
router.get('/tenants/:slug/reports/monthly', async (req, res) => {
  const { data: tenant } = await sb().from('tenants').select('id, name, plan').eq('slug', req.params.slug).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const [year, mo] = month.split('-').map(Number);
  const startDate = new Date(year, mo - 1, 1).toISOString();
  const endDate   = new Date(year, mo, 0, 23, 59, 59).toISOString();
  const tid       = tenant.id;

  const [leadsR, cartsR, ticketsR, loyaltyR, wfR, attrR, cfgR] = await Promise.all([
    sb().from('leads').select('score, category').eq('tenant_id', tid).gte('created_at', startDate).lte('created_at', endDate),
    sb().from('cart_recoveries').select('status, cart_value, recovery_value').eq('tenant_id', tid).gte('created_at', startDate).lte('created_at', endDate),
    sb().from('support_tickets').select('status').eq('tenant_id', tid).gte('created_at', startDate).lte('created_at', endDate),
    sb().from('loyalty_transactions').select('points').eq('tenant_id', tid).gte('created_at', startDate).lte('created_at', endDate),
    sb().from('workflow_states').select('workflow_id, is_active, run_count, error_count').eq('tenant_id', tid),
    sb().from('revenue_attribution').select('workflow_id, revenue').eq('tenant_id', tid).gte('attributed_at', startDate).lte('attributed_at', endDate),
    sb().from('tenant_config').select('brand_name').eq('tenant_id', tid).single(),
  ]);

  const leads    = leadsR.data    || [];
  const carts    = cartsR.data    || [];
  const tickets  = ticketsR.data  || [];
  const loyalty  = loyaltyR.data  || [];
  const wfs      = wfR.data       || [];
  const attr     = attrR.data     || [];
  const brandName = cfgR.data?.brand_name || tenant.name;
  const monthLabel = new Date(year, mo - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const totalLeads      = leads.length;
  const hotLeads        = leads.filter(l => l.category === 'hot').length;
  const recoveredCarts  = carts.filter(c => c.status === 'recovered').length;
  const recoveryValue   = carts.filter(c => c.status === 'recovered').reduce((s, c) => s + (c.recovery_value || 0), 0);
  const closedTickets   = tickets.filter(t => t.status === 'closed').length;
  const loyaltyPoints   = loyalty.reduce((s, l) => s + (l.points || 0), 0);
  const totalRevenue    = attr.reduce((s, a) => s + (a.revenue || 0), 0);
  const activeWorkflows = wfs.filter(w => w.is_active).length;

  const wfRows = wfs.slice(0, 12).map(w =>
    `<tr><td>${w.workflow_id}</td><td>${w.is_active ? '<span style="color:#16a34a">● Active</span>' : '<span style="color:#94a3b8">○ Inactive</span>'}</td><td>${(w.run_count || 0).toLocaleString()}</td><td style="color:${(w.error_count||0)>0?'#dc2626':'#1e293b'}">${w.error_count || 0}</td></tr>`
  ).join('');

  const attrRows = attr.slice(0, 8).map(a =>
    `<tr><td>${a.workflow_id}</td><td style="font-weight:600">£${Number(a.revenue).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${brandName} — ${monthLabel} Report</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,system-ui,sans-serif;color:#1e293b;background:#fff;padding:48px;max-width:920px;margin:0 auto}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;padding-bottom:24px;border-bottom:2px solid #e2e8f0}
    .brand{font-size:1.5rem;font-weight:700;color:#0f172a}.brand-sub{color:#64748b;margin-top:4px;font-size:.9rem}
    .meta{text-align:right;color:#64748b;font-size:.875rem}.meta strong{display:block;font-size:1rem;color:#1e293b;margin-bottom:4px}
    .pill{display:inline-block;padding:2px 10px;border-radius:20px;background:#dbeafe;color:#1d4ed8;font-size:.75rem;font-weight:600;text-transform:uppercase}
    h2{font-size:.875rem;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin:32px 0 16px}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:12px}
    .stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px}
    .sv{font-size:1.8rem;font-weight:700;color:#0f172a}.sl{font-size:.8rem;color:#64748b;margin-top:4px}
    table{width:100%;border-collapse:collapse;font-size:.875rem}
    th{text-align:left;padding:10px 12px;background:#f8fafc;color:#475569;font-weight:600;border-bottom:1px solid #e2e8f0}
    td{padding:10px 12px;border-bottom:1px solid #f1f5f9}
    .ftr{margin-top:48px;padding-top:24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:.8rem;display:flex;justify-content:space-between}
    @media print{body{padding:24px}.no-print{display:none}}
  </style>
</head>
<body>
  <div class="hdr">
    <div><div class="brand">D2C AI Growth Suite</div><div class="brand-sub">${brandName}</div></div>
    <div class="meta"><strong>${monthLabel} Report</strong>Generated ${new Date().toLocaleDateString('en-GB')}<br/><span class="pill">${tenant.plan}</span></div>
  </div>
  <h2>Key Metrics</h2>
  <div class="grid">
    <div class="stat"><div class="sv">${totalLeads}</div><div class="sl">Total Leads</div></div>
    <div class="stat"><div class="sv">${hotLeads}</div><div class="sl">Hot Leads</div></div>
    <div class="stat"><div class="sv">${recoveredCarts}</div><div class="sl">Carts Recovered</div></div>
    <div class="stat"><div class="sv">£${recoveryValue.toLocaleString('en-GB',{minimumFractionDigits:0})}</div><div class="sl">Recovery Revenue</div></div>
  </div>
  <div class="grid">
    <div class="stat"><div class="sv">${loyaltyPoints.toLocaleString()}</div><div class="sl">Loyalty Points Issued</div></div>
    <div class="stat"><div class="sv">${closedTickets}</div><div class="sl">Tickets Resolved</div></div>
    <div class="stat"><div class="sv">${activeWorkflows}/24</div><div class="sl">Active Workflows</div></div>
    <div class="stat"><div class="sv">£${totalRevenue.toLocaleString('en-GB',{minimumFractionDigits:0})}</div><div class="sl">Attributed Revenue</div></div>
  </div>
  <h2>Workflow Performance</h2>
  <table><thead><tr><th>Workflow</th><th>Status</th><th>Total Runs</th><th>Errors</th></tr></thead>
  <tbody>${wfRows || '<tr><td colspan="4" style="color:#94a3b8;text-align:center;padding:20px">No workflow data this month</td></tr>'}</tbody></table>
  ${attr.length > 0 ? `<h2>Revenue Attribution</h2><table><thead><tr><th>Workflow</th><th>Revenue</th></tr></thead><tbody>${attrRows}</tbody></table>` : ''}
  <div class="ftr"><span>D2C AI Growth Suite — Confidential</span><span class="no-print">Ctrl+P to save as PDF</span></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

module.exports = { reportsRouter: router };
