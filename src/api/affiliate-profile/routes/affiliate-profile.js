'use strict';

/**
 * affiliate-profile router (user-facing).
 *
 * All routes require authentication. Ownership scoping is enforced in the
 * controller — every handler reads ctx.state.user.id and binds it into the
 * query. There is deliberately NO default /affiliate-profiles route (find /
 * findOne / create / update / delete are all suppressed) so a hostile caller
 * can't enumerate profiles or use the default Strapi create to plant their
 * own row.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/affiliates/apply',
      handler: 'affiliate-profile.apply',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me',
      handler: 'affiliate-profile.me',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'POST',
      path: '/affiliates/me/regenerate-code',
      handler: 'affiliate-profile.regenerateMyCode',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me/referrals',
      handler: 'affiliate-profile.myReferrals',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me/stats',
      handler: 'affiliate-profile.myStats',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me/commissions',
      handler: 'affiliate-profile.myCommissions',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me/earnings',
      handler: 'affiliate-profile.myEarnings',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me/earnings-detail',
      handler: 'affiliate-profile.myEarningsDetail',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/affiliates/me/activity',
      handler: 'affiliate-profile.myActivity',
      config: { policies: [], middlewares: [] },
    },
  ],
};
