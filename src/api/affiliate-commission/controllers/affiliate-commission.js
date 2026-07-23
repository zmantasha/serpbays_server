'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

/**
 * The ledger has no public REST surface — reads happen via
 *   • /affiliates/me/commissions     (affiliate-profile controller)
 *   • /admin/affiliates/:id/commissions   (admin controller)
 * and writes only happen via the affiliate-commission service.
 */
module.exports = createCoreController('api::affiliate-commission.affiliate-commission');
