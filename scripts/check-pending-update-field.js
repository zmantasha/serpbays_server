#!/usr/bin/env node
'use strict';
(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');
  try {
    for (const id of [15, 18, 11]) {
      const ctx = {
        params: { id: String(id) },
        state: { user: { id: 1, role: { type: 'admin' } } },
        notFound: m => ({ error: m }),
        internalServerError: m => ({ error: m }),
        _body: null, send: function (b) { this._body = b; return b; },
      };
      await strapi.controller('api::admin.websites').findOne(ctx);
      const d = ctx._body?.data;
      log(`pw ${id} (${d?.domain}) status=${d?.status} pendingUpdate=${JSON.stringify(d?.pendingUpdate)}`);
    }
  } catch (e) { log('ERR:', e.message, e.stack); }
  finally { await strapi.destroy(); process.exit(0); }
})();
