'use strict';

const tatUpdater = require('./tat-updater');
const orderCancellation = require('./order-cancellation');
const autosendMarketing = require('./autosend-marketing');

module.exports = {
    ...tatUpdater,
    ...orderCancellation,
    ...autosendMarketing,
};
