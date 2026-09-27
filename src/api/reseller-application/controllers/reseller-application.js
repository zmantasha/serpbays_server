'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

// Publisher mode, as the rest of the API defines it (marketplace controller): Advertiser === false || Publisher === true.
const inPublisherMode = (u) => u.Advertiser === false || u.Publisher === true;
const isUrl = (v, host) => { try { const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); return host ? u.hostname.replace(/^www\./, '').endsWith(host) : !!u.hostname.includes('.'); } catch { return false; } };
const pub = (a) => a && ({ id: a.id, status: a.status, decisionDueAt: a.decisionDueAt, agencyUrl: a.agencyUrl, inventoryCount: a.inventoryCount, feeAmount: a.feeAmount, createdAt: a.createdAt, reviewedAt: a.reviewedAt, rejectReason: a.rejectReason, reviewNote: a.reviewNote, issuedCode: a.issuedCode ? { code: a.issuedCode.code, usageLimit: a.issuedCode.usageLimit, usedCount: a.issuedCode.usedCount, isActive: a.issuedCode.isActive } : null });

module.exports = createCoreController('api::reseller-application.reseller-application', ({ strapi }) => ({
  /** GET /reseller-applications/me — latest application + whether a new one may be submitted. */
  async me(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service('api::reseller-application.reseller-application');
    const config = await strapi.db.query('api::global-config.global-config').findOne({});
    const enabled = !config || config.resellerApplicationsEnabled !== false;
    const latest = await strapi.db.query('api::reseller-application.reseller-application').findOne({ where: { applicant: user.id }, orderBy: { createdAt: 'desc' }, populate: ['issuedCode'] });
    let canApply = enabled && inPublisherMode(user); let reason = enabled ? (inPublisherMode(user) ? null : 'publisher_mode_required') : 'disabled';
    if (canApply && latest) {
      if (latest.status === 'submitted' || latest.status === 'in_review') { canApply = false; reason = 'open_application'; }
      else if (latest.status === 'approved') { canApply = false; reason = 'already_approved'; }
      // 'refunded' (no decision in time) → may apply again straight away.
      else if (latest.status === 'rejected') {
        const days = (Date.now() - new Date(latest.reviewedAt || latest.createdAt).getTime()) / 86400000;
        if (days < svc.COOLDOWN_DAYS) { canApply = false; reason = 'cooldown'; }
      }
    }
    ctx.body = { data: { application: pub(latest), canApply, reason, fee: svc.FEE_USD, cooldownDays: svc.COOLDOWN_DAYS, reviewWorkingDays: svc.REVIEW_WORKING_DAYS } };
  },

  /** POST /reseller-applications — validate, charge $10 from main balance, create. */
  async submit(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service('api::reseller-application.reseller-application');
    const config = await strapi.db.query('api::global-config.global-config').findOne({});
    if (config && config.resellerApplicationsEnabled === false) return ctx.badRequest('Reseller applications are currently closed.');
    if (!inPublisherMode(user)) return ctx.badRequest('Switch to publisher mode to apply as a reseller.');
    const b = ctx.request.body || {};
    const agencyUrl = String(b.agencyUrl || '').trim(); const linkedinUrl = String(b.linkedinUrl || '').trim(); const companyLinkedinUrl = String(b.companyLinkedinUrl || '').trim();
    const message = String(b.message || '').trim(); const ownership = ['own', 'sourced', 'mixed'].includes(b.inventoryOwnership) ? b.inventoryOwnership : 'sourced';
    if (!isUrl(agencyUrl)) return ctx.badRequest('Enter a valid agency/website URL.');
    if (!isUrl(linkedinUrl, 'linkedin.com')) return ctx.badRequest('Enter a valid LinkedIn profile URL.');
    if (companyLinkedinUrl && !isUrl(companyLinkedinUrl, 'linkedin.com')) return ctx.badRequest('Company LinkedIn must be a linkedin.com URL.');
    if (message.length < 20 || message.length > 600) return ctx.badRequest('Message must be between 20 and 600 characters.');
    if (b.feeConsent !== true) return ctx.badRequest('You must accept the non-refundable review fee.');
    let rows; try { rows = svc.parseInventory(b.inventoryCsv); } catch (e) { return ctx.badRequest(e.message); }

    // One open application per account; cooldown after a rejection.
    const latest = await strapi.db.query('api::reseller-application.reseller-application').findOne({ where: { applicant: user.id }, orderBy: { createdAt: 'desc' } });
    if (latest && ['submitted', 'in_review'].includes(latest.status)) return ctx.badRequest('You already have an application under review.');
    if (latest && latest.status === 'approved') return ctx.badRequest('Your account already has an approved reseller application.');
    if (latest && latest.status === 'rejected' && (Date.now() - new Date(latest.reviewedAt || latest.createdAt).getTime()) / 86400000 < svc.COOLDOWN_DAYS) return ctx.badRequest(`You can re-apply ${svc.COOLDOWN_DAYS} days after a rejection.`);

    let txId;
    try { txId = await svc.chargeFee(user.id, 'Reseller application review fee (non-refundable)'); }
    catch (e) { if (e.message === 'INSUFFICIENT_FUNDS') { ctx.status = 402; ctx.body = { error: { status: 402, name: 'PaymentRequired', message: `Add at least $${svc.FEE_USD} to your wallet (main balance) to submit.` } }; return; } throw e; }

    let app;
    try {
      app = await strapi.entityService.create('api::reseller-application.reseller-application', { data: {
        applicant: user.id, status: 'submitted', agencyUrl, linkedinUrl, companyLinkedinUrl: companyLinkedinUrl || null, inventoryCount: rows.length, inventoryOwnership: ownership,
        inventoryRows: rows, message, feeAmount: svc.FEE_USD, feeTransaction: txId, submittedIp: ctx.request.ip, decisionDueAt: svc.addWorkingDays(new Date(), svc.REVIEW_WORKING_DAYS),
      } });
    } catch (e) {
      strapi.log.error(`[reseller-application] create failed after charging user ${user.id} tx ${txId}: ${e.message} — reversing fee`);
      try { await svc.refundFee(user.id, txId, 'application could not be saved'); } catch (re) { strapi.log.error(`[reseller-application] REFUND FAILED user ${user.id} tx ${txId}: ${re.message}`); }
      throw e;
    }
    try {
      const due = new Date(app.decisionDueAt).toDateString();
      await strapi.service('api::notification.notification').createNotification({ recipientId: user.id, type: 'system', action: 'system_update', title: 'Reseller application received', message: `We received your reseller application (#${app.id}). You will have a decision by ${due} (${svc.REVIEW_WORKING_DAYS} working days); if not, the $${svc.FEE_USD} fee is refunded automatically.` });
      svc.email(user.email, `Reseller application #${app.id} received`, `<p>Hi ${user.firstName || ''},</p><p>We received your reseller application (<b>#${app.id}</b>, ${rows.length} sites). Our team reviews the inventory, compares prices with the market and checks your LinkedIn profile.</p><p>You will have a decision by <b>${due}</b> (${svc.REVIEW_WORKING_DAYS} working days). If we have not decided by then, the $${svc.FEE_USD} review fee is refunded to your wallet automatically.</p><p>Track the status any time: <a href="${(process.env.CLIENT_URL || 'https://app.serpbays.com').replace(/\/$/, '')}/publisher/reseller-application">your reseller application</a>.</p><p>— SerpBays</p>`);
    } catch (e) { strapi.log.warn(`[reseller-application] notification failed: ${e.message}`); }
    strapi.log.info(`[reseller-application] #${app.id} submitted by user ${user.id} (${rows.length} sites, tx ${txId})`);
    ctx.body = { data: pub(app) };
  },
}));
