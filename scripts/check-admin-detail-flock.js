#!/usr/bin/env node
'use strict';
(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');
  try {
    for (const id of [15, 18, 14, 11]) {
      const ctx = {
        params: { id: String(id) },
        state: { user: { id: 1, role: { type: 'admin' } } },
        notFound: m => ({ error: m }),
        internalServerError: m => ({ error: m }),
        _body: null, send: function (b) { this._body = b; return b; },
      };
      const body = await strapi.controller('api::admin.websites').findOne(ctx) || ctx._body;
      const d = body?.data || body;
      log(`pw ${id} (${d?.domain}): admin returns price=${d?.pricing?.general?.guestPost}, status=${d?.status}`);
    }
  } catch (e) { log('ERR:', e.message); }
  finally { await strapi.destroy(); process.exit(0); }
})();
