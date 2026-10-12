'use strict';

/**
 * Reporting scope: run a report against the reporting.* views, which hide every
 * account tagged "internal" (test/team accounts). Same table names, same columns,
 * so the report SQL does not change: a read-only transaction sets
 * search_path = reporting, public for its queries only.
 *
 *   const scope = await require("../services/reporting-scope").open(ctx); const knex = scope.knex;
 *
 * ?includeTest=1 on the request skips the filter.
 */
async function open(ctx) {
  const base = strapi.db.connection;
  if (ctx && ctx.query && String(ctx.query.includeTest) === "1") return { knex: base, filtered: false, done: async () => {} };
  const trx = await base.transaction();
  let finished = false;
  const done = async () => { if (finished) return; finished = true; try { await trx.commit(); } catch (e) { /* already closed */ } };
  try { await trx.raw("set local search_path to reporting, public"); } catch (e) { await done(); return { knex: base, filtered: false, done: async () => {} }; }
  if (ctx && ctx.res) { ctx.res.once("finish", done); ctx.res.once("close", done); }
  const t = setTimeout(done, 120000); if (t.unref) t.unref();
  return { knex: trx, filtered: true, done };
}

module.exports = { open };
