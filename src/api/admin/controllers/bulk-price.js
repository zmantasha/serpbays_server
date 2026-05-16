'use strict';

const bulkPriceService = require('../services/bulk-price');

function getActor(ctx) {
  const u = ctx.state.user;
  if (!u) return null;
  return { id: u.id, email: u.email || null, username: u.username || null };
}

module.exports = {
  /**
   * GET /admin/marketplace/bulk-price/publishers
   * Query: { search?, limit? }
   * Returns publishers that have approved publisher_website rows,
   * for the export wizard's typeahead.
   */
  async listPublishers(ctx) {
    try {
      const { search = '', limit = 50 } = ctx.query;
      const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const items = await bulkPriceService.listPublishers({
        search: String(search || ''),
        limit: lim,
      });
      ctx.send({ data: items });
    } catch (err) {
      console.error('[BULK-PRICE LIST-PUBLISHERS]', err);
      ctx.internalServerError('Failed to list publishers');
    }
  },

  /**
   * GET /admin/marketplace/bulk-price/eligible-count
   * Query: { publisherId, niche? }
   * Live "X sites match" preview before committing the export.
   */
  async eligibleCount(ctx) {
    try {
      const { publisherId, niche } = ctx.query;
      const id = parseInt(publisherId, 10);
      if (!Number.isFinite(id)) return ctx.badRequest('publisherId required');
      const count = await bulkPriceService.countPublisherSites({
        publisherId: id,
        niche: niche || null,
      });
      ctx.send({ data: { count } });
    } catch (err) {
      console.error('[BULK-PRICE ELIGIBLE-COUNT]', err);
      ctx.internalServerError('Failed to count eligible sites');
    }
  },

  /**
   * POST /admin/marketplace/bulk-price/export
   * Body: { publisherId, niche? }
   * Returns a CSV download with current prices for the matching sites.
   */
  async export(ctx) {
    try {
      const { publisherId, niche } = ctx.request.body || {};
      const id = parseInt(publisherId, 10);
      if (!Number.isFinite(id)) return ctx.badRequest('publisherId required');

      const result = await bulkPriceService.exportByPublisher({
        publisherId: id,
        niche: niche || null,
        actor: getActor(ctx),
      });

      console.log(
        `[ADMIN ACTION] Bulk-price export jobId=${result.jobId} publisher=${id} ` +
        `niche=${niche || '-'} count=${result.count}`
      );

      ctx.set('Content-Type', 'text/csv; charset=utf-8');
      ctx.set('Content-Disposition', `attachment; filename="${result.filename}"`);
      ctx.set('X-Bulk-Refresh-Job-Id', String(result.jobId));
      ctx.set('X-Bulk-Refresh-Count', String(result.count));
      ctx.body = result.csvText;
    } catch (err) {
      console.error('[BULK-PRICE EXPORT]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError(err.message || 'Export failed');
    }
  },

  /**
   * POST /admin/marketplace/bulk-price/preview
   * Body: { csv, filename? }
   */
  async preview(ctx) {
    try {
      const { csv, filename } = ctx.request.body || {};
      if (typeof csv !== 'string' || csv.trim().length === 0) {
        return ctx.badRequest('csv body field is required');
      }
      const preview = await bulkPriceService.buildPreview({
        csvText: csv,
        csvFilename: filename || null,
      });
      ctx.send({ data: preview });
    } catch (err) {
      console.error('[BULK-PRICE PREVIEW]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError(err.message || 'Preview failed');
    }
  },

  /**
   * POST /admin/marketplace/bulk-price/commit
   * Body: { csv, filename?, label? }
   */
  async commit(ctx) {
    try {
      const { csv, filename, label } = ctx.request.body || {};
      if (typeof csv !== 'string' || csv.trim().length === 0) {
        return ctx.badRequest('csv body field is required');
      }
      const result = await bulkPriceService.commitCsv({
        csvText: csv,
        csvFilename: filename || null,
        label: label || null,
        actor: getActor(ctx),
      });
      console.log(
        `[ADMIN ACTION] Bulk-price commit jobId=${result.jobId} ` +
        `updated=${result.summary.updated} unchanged=${result.summary.unchanged}`
      );
      ctx.send({ data: result });
    } catch (err) {
      console.error('[BULK-PRICE COMMIT]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError(err.message || 'Commit failed');
    }
  },
};
