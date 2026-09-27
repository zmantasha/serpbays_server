'use strict';

/**
 * Reseller-application review guarantee (2026-09-27): if no decision was made
 * within 7 working days of submission, the $10 fee goes back to the applicant's
 * main balance and the application closes as `refunded`. Runs daily; each row
 * is handled once (status flips inside the same pass). Single Strapi instance —
 * do not run two instances without guarding this.
 */
module.exports = {
  resellerApplicationRefunds: {
    task: async ({ strapi }) => {
      const UID = 'api::reseller-application.reseller-application';
      const svc = strapi.service(UID);
      const due = await strapi.db.query(UID).findMany({
        where: { status: { $in: ['submitted', 'in_review'] }, decisionDueAt: { $lt: new Date() } },
        populate: ['applicant', 'feeTransaction'], limit: 200,
      });
      if (!due.length) return;
      console.log(`[Reseller Refunds] ${due.length} application(s) past the ${svc.REVIEW_WORKING_DAYS}-working-day window`);
      for (const a of due) {
        try {
          if (!a.applicant || !a.feeTransaction) { console.warn(`[Reseller Refunds] #${a.id} has no applicant/fee tx — skipped`); continue; }
          const refundId = await svc.refundFee(a.applicant.id, a.feeTransaction.id, `no decision within ${svc.REVIEW_WORKING_DAYS} working days (application #${a.id})`);
          await strapi.db.query(UID).update({ where: { id: a.id }, data: { status: 'refunded', refundTransaction: refundId, reviewedAt: new Date(), reviewNote: 'Auto-closed: review window passed, fee refunded.' } });
          try { await strapi.service('api::notification.notification').createNotification({ recipientId: a.applicant.id, type: 'system', action: 'system_update', data: { url: '/publisher/reseller-application' }, title: 'Reseller application fee refunded', message: `We could not review application #${a.id} within ${svc.REVIEW_WORKING_DAYS} working days, so the $${svc.FEE_USD} fee is back in your wallet. You are welcome to apply again.` }); } catch (e) { console.warn('[Reseller Refunds] notification failed:', e.message); }
          svc.email(a.applicant.email, `Reseller application #${a.id}: fee refunded`, `<p>Hi ${a.applicant.firstName || ''},</p><p>We could not review your reseller application <b>#${a.id}</b> within ${svc.REVIEW_WORKING_DAYS} working days, so the $${svc.FEE_USD} review fee has been returned to your wallet's main balance.</p><p>You are welcome to apply again at any time.</p><p>— SerpBays</p>`);
          console.log(`[Reseller Refunds] #${a.id} refunded to user ${a.applicant.id} (refund tx ${refundId})`);
        } catch (e) {
          console.error(`[Reseller Refunds] #${a.id} failed: ${e.message}`);
        }
      }
    },
    options: { rule: '30 3 * * *' }, // daily 03:30 UTC
  },
};
