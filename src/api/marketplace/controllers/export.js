'use strict';

/**
 * Marketplace Export Controller (VIP only)
 */
module.exports = {
  async exportCSV(ctx) {
    try {
      const { user } = ctx.state;
      if (!user) return ctx.unauthorized('You must be logged in');

      // Check VIP status
      const fullUser = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: user.id } });
      if (!fullUser || !fullUser.isVIP) {
        return ctx.forbidden('This feature is only available for VIP users');
      }

      // Check VIP settings
      const vipSettings = await strapi.service('api::vip-settings.vip-settings').getSettings();
      if (!vipSettings.canDownloadMarketplace) {
        return ctx.forbidden('Marketplace export is currently disabled');
      }

      const { websiteIds } = ctx.request.body;
      const maxItems = vipSettings.downloadMaxItems || 500;

      // Build query
      const knex = strapi.db.connection;
      let query = knex('websites')
        .select(
          'websites.id',
          'websites.url',
          'websites.price',
          'websites.linkInsertionPrice',
          'websites.da',
          'websites.dr',
          'websites.traffic',
          'websites.spamScore',
          'websites.language',
          'websites.country',
          'websites.category',
          'websites.backlinkValidity',
          'websites.linkType',
          'websites.maxLinksAllowed',
          'websites.turnaroundTime'
        )
        .where('websites.status', 'approved')
        .where('websites.publishedAt', '!=', null)
        .limit(maxItems);

      // If specific IDs provided, filter by them
      if (websiteIds && Array.isArray(websiteIds) && websiteIds.length > 0) {
        query = query.whereIn('websites.id', websiteIds.slice(0, maxItems));
      }

      const websites = await query;

      // Apply VIP discount to prices
      const discountPct = parseFloat(vipSettings.discountPercentage || 0);

      // Build CSV
      const headers = [
        'URL', 'Guest Post Price', 'Link Insertion Price',
        'VIP GP Price', 'VIP LI Price',
        'DA', 'DR', 'Traffic', 'Spam Score',
        'Language', 'Country', 'Category',
        'Backlink Validity', 'Link Type', 'Max Links', 'Turnaround Time'
      ];

      const rows = websites.map(w => {
        const gpPrice = parseFloat(w.price || 0);
        const liPrice = parseFloat(w.linkInsertionPrice || 0);
        const vipGP = discountPct > 0 ? (gpPrice * (1 - discountPct / 100)).toFixed(2) : gpPrice.toFixed(2);
        const vipLI = discountPct > 0 ? (liPrice * (1 - discountPct / 100)).toFixed(2) : liPrice.toFixed(2);

        return [
          w.url || '',
          gpPrice.toFixed(2),
          liPrice.toFixed(2),
          vipGP,
          vipLI,
          w.da || '',
          w.dr || '',
          w.traffic || '',
          w.spamScore || '',
          w.language || '',
          w.country || '',
          w.category || '',
          w.backlinkValidity || '',
          w.linkType || '',
          w.maxLinksAllowed || '',
          w.turnaroundTime || ''
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      });

      const csv = [headers.join(','), ...rows].join('\n');

      ctx.set('Content-Type', 'text/csv');
      ctx.set('Content-Disposition', `attachment; filename="serpbays_marketplace_export_${new Date().toISOString().split('T')[0]}.csv"`);
      ctx.body = csv;

    } catch (error) {
      console.error('[MARKETPLACE EXPORT] Error:', error);
      ctx.throw(500, 'Failed to export marketplace data');
    }
  }
};
