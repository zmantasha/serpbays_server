'use strict';

module.exports = {
  // GET /admin/sample-requests?status=open|fulfilled|expired (default open) — one row per listing with buyer count
  async list(ctx) {
    const knex = strapi.db.connection;
    const status = ['open', 'fulfilled', 'expired'].includes(ctx.query.status) ? ctx.query.status : 'open';
    const rows = await knex('sample_requests as r')
      .join('sample_requests_marketplace_lnk as rm', 'rm.sample_request_id', 'r.id')
      .join('marketplaces as m', 'm.id', 'rm.marketplace_id')
      .leftJoin('marketplaces_publisher_lnk as mp', 'mp.marketplace_id', 'm.id')
      .leftJoin('up_users as u', 'u.id', 'mp.user_id')
      .leftJoin('publisher_websites as pw', 'pw.marketplace_id', 'm.id')
      .where('r.status', status)
      .groupBy('m.id', 'm.url', 'm.price', 'm.ahrefs_dr', 'm.sample_links', 'u.id', 'u.email', 'pw.id')
      .select('m.id as marketplaceId', 'm.url', 'm.price', 'm.ahrefs_dr as dr', 'm.sample_links as sampleLinks', 'u.id as publisherId', 'u.email as publisherEmail', 'pw.id as publisherWebsiteId',
        knex.raw('count(*)::int as requests'), knex.raw('min(r.created_at) as first_requested'), knex.raw('max(r.created_at) as last_requested'), knex.raw('max(r.publisher_notified_at) as publisher_notified_at'))
      .orderBy([{ column: 'requests', order: 'desc' }, { column: 'first_requested', order: 'asc' }]).limit(500);
    const totals = await knex('sample_requests').select('status').count('* as c').groupBy('status');
    ctx.body = { data: rows.map((r) => ({ ...r, houseListing: r.publisherId === 42, hasSamples: !!(r.sampleLinks && !['[]', 'null', ''].includes(String(r.sampleLinks).trim())) })), meta: { byStatus: Object.fromEntries(totals.map((t) => [t.status, Number(t.c)])) } };
  },
};
