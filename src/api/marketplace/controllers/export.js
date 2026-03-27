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
      const maxItems = parseInt(vipSettings.downloadMaxItems) || 0;

      if (maxItems <= 0) {
        return ctx.forbidden('Marketplace export limit is not configured. Contact admin.');
      }

      // Validate selected count against admin-defined limit
      if (websiteIds && Array.isArray(websiteIds) && websiteIds.length > maxItems) {
        return ctx.badRequest(`Maximum ${maxItems} websites per export`);
      }

      // Build query using correct table name (marketplaces) and snake_case column names
      const knex = strapi.db.connection;
      let query = knex('marketplaces')
        .select(
          'id',
          'url',
          'price',
          'link_insertion_price',
          'moz_da',
          'ahrefs_dr',
          'ahrefs_traffic',
          'spam_score',
          'language',
          'countries',
          'category',
          'backlink_validity',
          'backlink_type',
          'dofollow_link',
          'tat',
          'ahrefs_rank',
          'ahrefs_referring_domain',
          'ahrefs_keywords',
          'semrush_authority_score'
        )
        .whereNotNull('published_at')
        .limit(maxItems);

      // If specific IDs provided, filter by them
      if (websiteIds && Array.isArray(websiteIds) && websiteIds.length > 0) {
        query = query.whereIn('id', websiteIds.slice(0, maxItems));
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
        'Backlink Validity', 'Backlink Type', 'Dofollow Links', 'TAT (days)',
        'Ahrefs Rank', 'Referring Domains', 'Ahrefs Keywords', 'Semrush AS'
      ];

      const rows = websites.map(w => {
        const gpPrice = parseFloat(w.price || 0);
        const liPrice = parseFloat(w.link_insertion_price || 0);
        const vipGP = discountPct > 0 ? (gpPrice * (1 - discountPct / 100)).toFixed(2) : gpPrice.toFixed(2);
        const vipLI = discountPct > 0 ? (liPrice * (1 - discountPct / 100)).toFixed(2) : liPrice.toFixed(2);

        return [
          w.url || '',
          gpPrice.toFixed(2),
          liPrice.toFixed(2),
          vipGP,
          vipLI,
          w.moz_da || '',
          w.ahrefs_dr || '',
          w.ahrefs_traffic || '',
          w.spam_score || '',
          w.language || '',
          w.countries || '',
          w.category || '',
          w.backlink_validity || '',
          w.backlink_type || '',
          w.dofollow_link || '',
          w.tat || '',
          w.ahrefs_rank || '',
          w.ahrefs_referring_domain || '',
          w.ahrefs_keywords || '',
          w.semrush_authority_score || ''
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
