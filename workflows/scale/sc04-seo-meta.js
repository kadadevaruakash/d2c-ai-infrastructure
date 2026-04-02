'use strict';
async function handleProductCreated(tenantId, payload, config) { return { ok: true, workflow: 'SC-04' }; }
module.exports = { handleProductCreated };
