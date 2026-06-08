#!/usr/bin/env node
'use strict';
(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');
  try {
    const ctx = {
      params: {}, request: { body: {} }, query: { page: '1', pageSize: '20' },
      state: { user: { id: 1, role: { type: 'admin' } } },
      notFound: m => ({ error: m }),
      internalServerError: m => ({ error: m }),
      badRequest: m => ({ error: m }),
      _body: null, send: function (b) { this._body = b; return b; },
    };
    await strapi.controller('api::admin.websites').find(ctx);
    const rows = ctx._body?.data || [];
    log(`Returned ${rows.length} rows. Sites with pending updates:`);
    for (const r of rows.filter(w => w.hasPendingUpdate)) {
      log(`  pw ${r.id} ${r.domain}: hasPendingUpdate=${r.hasPendingUpdate} count=${r.pendingUpdateCount} at=${r.pendingUpdateSubmittedAt}`);
    }
    log(`(${rows.filter(w => !w.hasPendingUpdate).length} rows without pending updates)`);
  } catch (e) { log('ERR:', e.message, e.stack); }
  finally { await strapi.destroy(); process.exit(0); }
})();
