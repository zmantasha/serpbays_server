'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');
const autosendMarketing = require('./autosend-marketing');
const resellerRefunds = require('./reseller-refunds');
const orderAutoApprove = require('./order-auto-approve');
const marketplaceRanking = require('./marketplace-ranking');
const sampleRequestExpiry = require('./sample-request-expiry');
const chatReminders = require('./chat-reminders');
const ratingVisibility = require('./rating-visibility');
const moderation = require('./moderation');
const salesDigest = require('./sales-digest');
const metricsRefresh = require('./metrics-refresh');
const affiliateJobs = {
    affiliateHoldRelease: { task: async () => { const r = await require('../services/affiliate').releaseHolds(); console.log(`[Affiliate] holds released=${r.released} referrals expired=${r.expired}`); }, options: { rule: '10 4 * * *' } },
    affiliateReconcile: { task: async () => { const r = await require('../services/affiliate').reconcile(); console.log('[Affiliate] reconcile ' + JSON.stringify(r)); }, options: { rule: '30 4 * * *' } },
    affiliatePayoutDraft: { task: async () => { const d = await require('../services/affiliate').payoutRun(); console.log(`[Affiliate] payout drafts=${d.length}`); }, options: { rule: '15 3 1 * *' } },
};
const gscAssured = {
    gscAssuredSweep: {
        task: async () => require('../services/gsc-assured').sweep(),
        options: { rule: '*/5 * * * *' }, // 2026-10-15: GSC-verified live sites get Assured
    },
};
const userDeleteSweep = {
    userDeleteSweep: {
        task: async () => require('../services/user-delete-guard').sweep(),
        options: { rule: '* * * * *' }, // email any user deletion the app did not catch (raw SQL)
    },
};

// 2026-10-13: wrap every task so the System health page can show last run / failures
module.exports = require('./registry').wrap({
    ...tatUpdater,
    ...orderCancellation,
    ...autosendMarketing,
    ...resellerRefunds,
    ...orderAutoApprove,
    ...marketplaceRanking,
    ...sampleRequestExpiry,
    ...chatReminders,
    ...ratingVisibility,
    ...moderation,
    ...salesDigest,
    ...metricsRefresh,
    ...userDeleteSweep,
    ...affiliateJobs,
    ...gscAssured,
});
