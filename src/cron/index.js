'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');
const autosendMarketing = require('./autosend-marketing');
const resellerRefunds = require('./reseller-refunds');
const orderAutoApprove = require('./order-auto-approve');
const marketplaceRanking = require('./marketplace-ranking');

module.exports = {
    ...tatUpdater,
    ...orderCancellation,
    ...autosendMarketing,
    ...resellerRefunds,
    ...orderAutoApprove,
    ...marketplaceRanking,
};
