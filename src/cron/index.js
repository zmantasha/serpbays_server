'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');
const apiLogPurge = require('./api-log-purge');

module.exports = {
    ...tatUpdater,
    ...orderCancellation,
    ...apiLogPurge,
};
