'use strict';

// Daily auto-approval of delivered orders past Global Config autoApproveDays
// (see src/api/order/services/auto-approve.js). Single instance only.
module.exports = {
  orderAutoApprove: {
    task: async ({ strapi }) => {
      try {
        const r = await strapi.service('api::order.auto-approve').run({ dryRun: false });
        console.log(`[Auto-approve Cron] completed=${r.completed.length} reminded=${r.reminded.length} errors=${r.errors.length}`);
      } catch (e) {
        console.error('[Auto-approve Cron] failed:', e.message);
      }
    },
    options: { rule: '15 2 * * *' }, // daily 02:15 UTC
  },
};
