'use strict';

// Nightly marketplace ranking recompute (see src/api/marketplace/services/ranking.js). Single instance only.
module.exports = {
  marketplaceRanking: {
    task: async ({ strapi }) => {
      try { const s = await strapi.service('api::marketplace.ranking').recompute(); console.log(`[Ranking Cron] scored=${s.scored} valuePool=${s.value_pool} ms=${s.ms}`); }
      catch (e) { console.error('[Ranking Cron] failed:', e.message); }
    },
    options: { rule: '50 3 * * *' }, // daily 03:50 UTC
  },
};
