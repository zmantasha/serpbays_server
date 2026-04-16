'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');
const autoApproval = require('./auto-approval');

module.exports = {
    ...tatUpdater,
    ...orderCancellation,
    ...autoApproval,
};
