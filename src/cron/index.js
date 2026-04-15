'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');
const orderAutoApprove = require('./order-auto-approve');

module.exports = {
    ...tatUpdater,
    ...orderCancellation,
    ...orderAutoApprove,
};
