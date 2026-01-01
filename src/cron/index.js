'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');

module.exports = {
    ...tatUpdater,
    ...orderCancellation,
};
