'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const UID = 'api::sample-request.sample-request';

module.exports = createCoreController(UID, ({ strapi }) => ({
  /** GET /sample-requests/mine → { data: { open: [marketplaceId…], fulfilled: [marketplaceId…] } } */
  async mine(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const rows = await strapi.db.query(UID).findMany({ where: { requester: user.id, status: { $in: ['open', 'fulfilled'] } }, populate: { marketplace: { select: ['id'] } }, limit: 500 });
    ctx.body = { data: { open: rows.filter((r) => r.status === 'open').map((r) => r.marketplace?.id).filter(Boolean), fulfilled: rows.filter((r) => r.status === 'fulfilled').map((r) => r.marketplace?.id).filter(Boolean) } };
  },

  /** POST /sample-requests { marketplaceId } */
  async submit(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service(UID);
    const id = parseInt(ctx.request.body?.marketplaceId, 10);
    if (!Number.isFinite(id)) return ctx.badRequest('marketplaceId is required.');
    const m = await strapi.db.query('api::marketplace.marketplace').findOne({ where: { id }, select: ['id', 'url', 'sample_links', 'status', 'publishedAt'], populate: { publisher: { select: ['id', 'email', 'firstName'] } } });
    if (!m || !m.publishedAt || (m.status && m.status !== 'active')) return ctx.notFound('Listing not found.');
    if (svc.hasSamples(m.sample_links)) return ctx.badRequest('This listing already has a sample.');
    if (m.publisher?.id === user.id) return ctx.badRequest('This is your own listing.');
    const existing = await strapi.db.query(UID).findOne({ where: { marketplace: id, requester: user.id, status: 'open' } });
    if (existing) { ctx.body = { data: { id: existing.id, status: 'open', alreadyRequested: true } }; return; }
    const openCount = await strapi.db.query(UID).count({ where: { requester: user.id, status: 'open' } });
    if (openCount >= svc.MAX_OPEN_PER_BUYER) return ctx.badRequest(`You have ${svc.MAX_OPEN_PER_BUYER} open sample requests — wait for some to be answered.`);
    const created = await strapi.entityService.create(UID, { data: { marketplace: id, requester: user.id, publisher: m.publisher?.id || null, status: 'open' } });
    const siteOpen = await strapi.db.query(UID).count({ where: { marketplace: id, status: 'open' } });
    const notified = await svc.notifyPublisher(m, m.publisher, siteOpen);
    if (notified) await strapi.db.query(UID).update({ where: { id: created.id }, data: { publisherNotifiedAt: new Date() } });
    strapi.log.info(`[sample-request] #${created.id} user ${user.id} → marketplace ${id} (${m.url}), publisher ${m.publisher?.id || 'none'}`);
    ctx.body = { data: { id: created.id, status: 'open', alreadyRequested: false } };
  },
}));
