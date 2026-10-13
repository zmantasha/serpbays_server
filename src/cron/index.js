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
});
