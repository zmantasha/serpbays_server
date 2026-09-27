'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

const UID = 'api::sample-request.sample-request';
const MAX_OPEN_PER_BUYER = 20;
const EXPIRE_DAYS = 30;
const appUrl = () => (process.env.CLIENT_URL || 'https://app.serpbays.com').replace(/\/$/, '');
const hasSamples = (v) => { if (!v) return false; if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x.trim()); if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a.some((x) => typeof x === 'string' && x.trim()) : v.trim().length > 0; } catch { return v.trim().length > 0; } } return false; };

module.exports = createCoreService(UID, ({ strapi }) => ({
  MAX_OPEN_PER_BUYER, EXPIRE_DAYS, hasSamples,

  async email(to, subject, html) {
    try { await strapi.service('api::global.autosend-service').send({ to, subject, html, tags: ['transactional', 'sample-request'] }); return true; }
    catch (e) { strapi.log.warn(`[sample-request] email "${subject}" to ${to} not delivered: ${e.message}`); return false; }
  },
  async notify(userId, title, message, url) {
    try { await strapi.service('api::notification.notification').createNotification({ recipientId: userId, type: 'system', action: 'system_update', title, message, data: url ? { url } : null }); }
    catch (e) { strapi.log.warn(`[sample-request] notification failed: ${e.message}`); }
  },

  /** Tell the publisher (once per site per 24 h) that buyers want a sample. */
  async notifyPublisher(marketplace, publisher, openCount) {
    // Every publisher is notified — including Sakshi's account, which is a normal publisher account.
    if (!publisher) return false;
    const recent = await strapi.db.query(UID).findOne({ where: { marketplace: marketplace.id, status: 'open', publisherNotifiedAt: { $gt: new Date(Date.now() - 86400000) } } });
    if (recent) return false;
    const pw = await strapi.db.connection('publisher_websites').where('marketplace_id', marketplace.id).select('id').first();
    const editPath = pw ? `/publisher/add-website?edit=${pw.id}` : '/publisher/my-websites';
    const editUrl = `${appUrl()}${editPath}`;
    const who = openCount > 1 ? `${openCount} buyers have` : 'A buyer has';
    await this.notify(publisher.id, `Sample requested for ${marketplace.url}`, `${who} asked to see a sample post before ordering. Add a sample link to the listing — buyers are notified automatically when you do.`, editPath);
    this.email(publisher.email, `A buyer wants to see a sample from ${marketplace.url}`, `<p>Hi ${publisher.firstName || ''},</p><p>${who} asked for a sample post on <b>${marketplace.url}</b> before placing an order.</p><p><a href="${editUrl}">Add a sample link to the listing</a> — it takes a minute, and every buyer who asked is notified automatically once it's there.</p><p>— SerpBays</p>`);
    return true;
  },

  /** Called when a listing gains sample links: close open requests and tell the buyers. */
  async fulfil(marketplaceId) {
    const open = await strapi.db.query(UID).findMany({ where: { marketplace: marketplaceId, status: 'open' }, populate: ['requester', 'marketplace'] });
    if (!open.length) return 0;
    // per-row updates: db.query().updateMany() cannot filter on a relation (marketplace) — it built an empty UPDATE
    for (const r of open) await strapi.db.query(UID).update({ where: { id: r.id }, data: { status: 'fulfilled', fulfilledAt: new Date() } });
    for (const r of open) {
      if (!r.requester) continue;
      const url = r.marketplace?.url || 'the site you asked about';
      await this.notify(r.requester.id, `Sample added for ${url}`, `The publisher added a sample post to ${url}. Open the listing to review it.`, `/marketplace?search=${encodeURIComponent(url)}`);
      this.email(r.requester.email, `Sample added for ${url}`, `<p>Hi ${r.requester.firstName || ''},</p><p>Good news — the publisher added a sample post to <b>${url}</b>, which you asked to see.</p><p><a href="${appUrl()}/marketplace?search=${encodeURIComponent(url)}">Open the listing</a></p><p>— SerpBays</p>`);
    }
    strapi.log.info(`[sample-request] ${open.length} request(s) fulfilled for marketplace ${marketplaceId}`);
    return open.length;
  },

  async expireOld() {
    const cutoff = new Date(Date.now() - EXPIRE_DAYS * 86400000);
    const rows = await strapi.db.query(UID).findMany({ where: { status: 'open', createdAt: { $lt: cutoff } }, select: ['id'], limit: 1000 });
    for (const r of rows) await strapi.db.query(UID).update({ where: { id: r.id }, data: { status: 'expired' } });
    return rows.length;
  },
}));
