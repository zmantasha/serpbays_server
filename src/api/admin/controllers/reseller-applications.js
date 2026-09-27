'use strict';

const DEFAULT_SITES = 25;
const MAX_SITES = 100;
const UID = 'api::reseller-application.reseller-application';
const REASONS = ['inventory_too_small', 'prices_above_market', 'profile_unclear', 'duplicate_inventory', 'quality_concerns', 'other'];

const shape = (a) => ({
  id: a.id, status: a.status, createdAt: a.createdAt, reviewedAt: a.reviewedAt, decisionDueAt: a.decisionDueAt,
  applicant: a.applicant ? { id: a.applicant.id, email: a.applicant.email, username: a.applicant.username, firstName: a.applicant.firstName, lastName: a.applicant.lastName, createdAt: a.applicant.createdAt } : null,
  agencyUrl: a.agencyUrl, linkedinUrl: a.linkedinUrl, companyLinkedinUrl: a.companyLinkedinUrl, inventoryCount: a.inventoryCount, inventoryOwnership: a.inventoryOwnership,
  message: a.message, feeAmount: a.feeAmount, feeTransactionId: a.feeTransaction?.id ?? null, rejectReason: a.rejectReason, reviewNote: a.reviewNote,
  reviewedBy: a.reviewedBy ? { id: a.reviewedBy.id, email: a.reviewedBy.email } : null,
  issuedCode: a.issuedCode ? { id: a.issuedCode.id, code: a.issuedCode.code, usageLimit: a.issuedCode.usageLimit, usedCount: a.issuedCode.usedCount, isActive: a.issuedCode.isActive } : null,
});
const POP = ['applicant', 'feeTransaction', 'issuedCode', 'reviewedBy'];

async function notify(strapi, userId, title, message) {
  try { await strapi.service('api::notification.notification').createNotification({ recipientId: userId, type: 'system', action: 'system_update', title, message, data: { url: '/publisher/reseller-application' } }); }
  catch (e) { strapi.log.warn(`[reseller-applications] notification failed: ${e.message}`); }
}

module.exports = {
  async list(ctx) {
    const { status, search, page = 1, pageSize = 25 } = ctx.query;
    const where = {};
    if (status && ['submitted', 'in_review', 'approved', 'rejected', 'refunded'].includes(status)) where.status = status;
    if (search) where.$or = [{ agencyUrl: { $containsi: search } }, { applicant: { email: { $containsi: search } } }];
    const limit = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100); const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
    const [rows, total, counts] = await Promise.all([
      strapi.db.query(UID).findMany({ where, orderBy: { createdAt: 'desc' }, limit, offset, populate: POP }),
      strapi.db.query(UID).count({ where }),
      strapi.db.connection('reseller_applications').select('status').count('* as c').groupBy('status'),
    ]);
    ctx.body = { data: rows.map(shape), meta: { total, page: Number(page), pageSize: limit, byStatus: Object.fromEntries(counts.map((c) => [c.status, Number(c.c)])) } };
  },

  async get(ctx) {
    const a = await strapi.db.query(UID).findOne({ where: { id: ctx.params.id }, populate: POP });
    if (!a) return ctx.notFound();
    const svc = strapi.service(UID);
    const [check, sitesListed, orders] = await Promise.all([
      svc.autoCheck(a.inventoryRows || []),
      strapi.db.connection('publisher_websites_current_publisher_id_lnk').where('user_id', a.applicant?.id || 0).count('* as c').first(),
      strapi.db.connection('orders_publisher_lnk').where('user_id', a.applicant?.id || 0).count('* as c').first(),
    ]);
    if (a.status === 'submitted') await strapi.db.query(UID).update({ where: { id: a.id }, data: { status: 'in_review' } });
    ctx.body = { data: { ...shape(a), status: a.status === 'submitted' ? 'in_review' : a.status, inventoryRows: a.inventoryRows || [], autoCheck: check, applicantStats: { sitesListed: Number(sitesListed?.c || 0), publisherOrders: Number(orders?.c || 0) } } };
  },

  async approve(ctx) {
    const a = await strapi.db.query(UID).findOne({ where: { id: ctx.params.id }, populate: ['applicant', 'issuedCode'] });
    if (!a) return ctx.notFound();
    if (a.status === 'approved' || a.issuedCode) return ctx.badRequest('Already approved.');
    if (a.status === 'rejected') return ctx.badRequest('Application was rejected; ask the applicant to re-apply.');
    if (a.status === 'refunded') return ctx.badRequest('The review window passed and the fee was refunded; ask the applicant to re-apply.');
    const limit = Math.min(Math.max(parseInt(ctx.request.body?.usageLimit, 10) || DEFAULT_SITES, 1), MAX_SITES);
    const admin = ctx.state.user;
    const code = await strapi.service('api::reseller-code.reseller-code').createResellerCode({
      assignedTo: a.applicant.id, assignedToName: [a.applicant.firstName, a.applicant.lastName].filter(Boolean).join(' ') || a.applicant.email,
      usageLimit: limit, isActive: true, notes: `Auto-issued from reseller application #${a.id} by ${admin.email} (${limit} sites)`,
    });
    const updated = await strapi.db.query(UID).update({ where: { id: a.id }, data: { status: 'approved', issuedCode: code.id, reviewedBy: admin.id, reviewedAt: new Date(), reviewNote: ctx.request.body?.note || null }, populate: POP });
    await notify(strapi, a.applicant.id, 'Reseller application approved', `Your reseller code is ${code.code}. It lets you add up to ${limit} websites without ownership verification — open Add Website and enter the code.`);
    strapi.service(UID).email(a.applicant.email, 'Your Serpbays reseller application is approved', `<p>Hi ${a.applicant.firstName || ''},</p><p>Good news — your reseller application <b>#${a.id}</b> is approved.</p><p>Your reseller code: <b style="font-size:18px">${code.code}</b> (valid for up to ${limit} websites).</p><p>Open <a href="${(process.env.CLIENT_URL || 'https://app.serpbays.com').replace(/\/$/, '')}/publisher/add-website">Add Website</a>, choose “Reseller Code” at the verification step and enter it — your sites are listed without per-site ownership checks.</p><p>— Serpbays</p>`);
    strapi.log.info(`[reseller-applications] #${a.id} approved by ${admin.email}; code ${code.code} (${limit} sites) for user ${a.applicant.id}`);
    ctx.body = { data: shape(updated) };
  },

  async reject(ctx) {
    const a = await strapi.db.query(UID).findOne({ where: { id: ctx.params.id }, populate: ['applicant'] });
    if (!a) return ctx.notFound();
    if (a.status === 'approved') return ctx.badRequest('Already approved.');
    if (a.status === 'rejected') return ctx.badRequest('Already rejected.');
    if (a.status === 'refunded') return ctx.badRequest('The review window passed and the fee was refunded.');
    const { reason, note } = ctx.request.body || {};
    if (!REASONS.includes(reason)) return ctx.badRequest('A rejection reason is required.');
    if (reason === 'other' && !(note && String(note).trim().length >= 10)) return ctx.badRequest('Add a note when the reason is "other".');
    const admin = ctx.state.user;
    const updated = await strapi.db.query(UID).update({ where: { id: a.id }, data: { status: 'rejected', rejectReason: reason, reviewNote: note ? String(note).trim() : null, reviewedBy: admin.id, reviewedAt: new Date() }, populate: POP });
    const human = { inventory_too_small: 'the inventory is too small for a reseller partnership', prices_above_market: 'the prices are above current market rates', profile_unclear: 'we could not verify your profile or agency', duplicate_inventory: 'most of the inventory is already listed on Serpbays', quality_concerns: 'the sites did not meet our quality bar', other: note || 'see note' }[reason];
    await notify(strapi, a.applicant.id, 'Reseller application not approved', `We reviewed your application (#${a.id}) and could not approve it: ${human}. You may re-apply after 30 days. The review fee is non-refundable.`);
    strapi.service(UID).email(a.applicant.email, `Reseller application #${a.id}: not approved`, `<p>Hi ${a.applicant.firstName || ''},</p><p>We reviewed your reseller application <b>#${a.id}</b> and could not approve it: ${human}.</p><p>You may re-apply after 30 days. The review fee is non-refundable.</p><p>— Serpbays</p>`);
    strapi.log.info(`[reseller-applications] #${a.id} rejected by ${admin.email}: ${reason}`);
    ctx.body = { data: shape(updated) };
  },

  /** Raise (or lower) the issued code's site limit, capped at 100. */
  async setCodeLimit(ctx) {
    const a = await strapi.db.query(UID).findOne({ where: { id: ctx.params.id }, populate: ['issuedCode', 'applicant'] });
    if (!a || !a.issuedCode) return ctx.notFound('No code issued for this application.');
    const limit = parseInt(ctx.request.body?.usageLimit, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_SITES) return ctx.badRequest(`Site limit must be between 1 and ${MAX_SITES}.`);
    if (limit < (a.issuedCode.usedCount || 0)) return ctx.badRequest(`Code already used ${a.issuedCode.usedCount} times; limit cannot be lower than that.`);
    await strapi.db.query('api::reseller-code.reseller-code').update({ where: { id: a.issuedCode.id }, data: { usageLimit: limit, notes: `${a.issuedCode.notes || ''}\nLimit set to ${limit} by ${ctx.state.user.email} on ${new Date().toISOString().slice(0, 10)}`.trim() } });
    await notify(strapi, a.applicant.id, 'Reseller code limit updated', `Your reseller code ${a.issuedCode.code} can now be used for up to ${limit} websites.`);
    const updated = await strapi.db.query(UID).findOne({ where: { id: a.id }, populate: POP });
    ctx.body = { data: shape(updated) };
  },
};
