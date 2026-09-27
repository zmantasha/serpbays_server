'use strict';

module.exports = {
  sampleRequestExpiry: {
    task: async ({ strapi }) => {
      try { const n = await strapi.service('api::sample-request.sample-request').expireOld(); if (n) console.log(`[Sample Requests Cron] expired ${n}`); }
      catch (e) { console.error('[Sample Requests Cron] failed:', e.message); }
    },
    options: { rule: '20 4 * * *' },
  },
};
