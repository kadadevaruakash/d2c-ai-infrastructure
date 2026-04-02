'use strict';
async function handleCartAbandoned(tenantId, payload, config) { return { ok: true, workflow: 'C-01' }; }
module.exports = { handleCartAbandoned };
