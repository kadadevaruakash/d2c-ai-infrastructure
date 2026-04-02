'use strict';
async function handleOrderCreated(tenantId, payload, config) { return { ok: true, workflow: 'R-01' }; }
module.exports = { handleOrderCreated };
