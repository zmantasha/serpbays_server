'use strict';

/**
 * Admin Bulk Metric Refresh — controller (thin).
 *
 * Each handler does request hygiene + actor extraction, then delegates
 * to the bulk-refresh service which holds all the actual logic. The
 * service is unit-testable; this file is just the Strapi-shaped glue.
 *
 * Auth: every route mounts policies: ['global::is-admin'] in the
 * companion routes file.
 */

const bulkRefreshService = require('../services/bulk-refresh');
const { getProfile, listTools } = require('../services/bulk-refresh-profiles');

function getActor(ctx) {
  const u = ctx.state.user;
  if (!u) return null;
  return {
    id: u.id,
    email: u.email || null,
    username: u.username || null,
  };
}

function validateTool(tool) {
  if (!tool || !listTools().includes(tool)) {
    const err = new Error(`Unknown tool: ${tool}. Valid: ${listTools().join(', ')}`);
    err.status = 400;
    throw err;
  }
}

module.exports = {
  /**
   * GET /admin/marketplace/bulk-refresh/status
   * Returns per-tool stats for the dashboard.
   */
  async status(ctx) {
    try {
      const status = await bulkRefreshService.computeStatus();
      ctx.send({ data: status });
    } catch (err) {
      console.error('[BULK-REFRESH STATUS]', err);
      ctx.internalServerError('Failed to compute status');
    }
  },

  /**
   * POST /admin/marketplace/bulk-refresh/preview
   * Body: { tool, csv, filename? }
   * Returns: per-row preview with classification + summary counters.
   * NO writes. Idempotent.
   */
  async preview(ctx) {
    try {
      const { tool, csv, filename } = ctx.request.body || {};
      validateTool(tool);
      if (typeof csv !== 'string' || csv.trim().length === 0) {
        return ctx.badRequest('csv body field is required');
      }

      const preview = await bulkRefreshService.buildPreview({
        tool,
        csvText: csv,
        csvFilename: filename || null,
      });
      ctx.send({ data: preview });
    } catch (err) {
      console.error('[BULK-REFRESH PREVIEW]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError(err.message || 'Preview failed');
    }
  },

  /**
   * POST /admin/marketplace/bulk-refresh/commit
   * Body: { tool, csv, filename?, label? }
   * Re-runs preview, then writes valid rows + advances per-tool clocks.
   */
  async commit(ctx) {
    try {
      const { tool, csv, filename, label } = ctx.request.body || {};
      validateTool(tool);
      if (typeof csv !== 'string' || csv.trim().length === 0) {
        return ctx.badRequest('csv body field is required');
      }

      const result = await bulkRefreshService.commitCsv({
        tool,
        csvText: csv,
        csvFilename: filename || null,
        label: label || null,
        actor: getActor(ctx),
      });
      console.log(
        `[ADMIN ACTION] Bulk-refresh commit jobId=${result.jobId} tool=${tool} ` +
        `updated=${result.summary.updated} unchanged=${result.summary.unchanged}`
      );
      ctx.send({ data: result });
    } catch (err) {
      console.error('[BULK-REFRESH COMMIT]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError(err.message || 'Commit failed');
    }
  },

  /**
   * GET /admin/marketplace/bulk-refresh/jobs
   * Query: { tool?, jobType?, status?, page=1, pageSize=20 }
   */
  async listJobs(ctx) {
    try {
      const { tool, jobType, status, page = 1, pageSize = 20 } = ctx.query;
      const where = {};
      if (tool) where.tool = String(tool);
      if (jobType) where.jobType = String(jobType);
      if (status) where.status = String(status);

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const sizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

      const [items, total] = await Promise.all([
        strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').findMany({
          where,
          orderBy: { createdAt: 'desc' },
          limit: sizeNum,
          offset: (pageNum - 1) * sizeNum,
        }),
        strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').count({ where }),
      ]);

      ctx.send({
        data: items,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: sizeNum,
            total,
            pageCount: Math.ceil(total / sizeNum),
          },
        },
      });
    } catch (err) {
      console.error('[BULK-REFRESH LIST JOBS]', err);
      ctx.internalServerError('Failed to list jobs');
    }
  },

  /**
   * GET /admin/marketplace/bulk-refresh/jobs/:id
   * Returns: one job + a sample of related history rows for the
   * detail modal.
   */
  async getJob(ctx) {
    try {
      const { id } = ctx.params;
      const jobId = parseInt(id, 10);
      if (!Number.isFinite(jobId)) return ctx.badRequest('Invalid job id');

      const job = await strapi.db
        .query('api::bulk-refresh-job.bulk-refresh-job')
        .findOne({ where: { id: jobId } });
      if (!job) return ctx.notFound('Job not found');

      const historySample = await strapi.db
        .query('api::marketplace-update-history.marketplace-update-history')
        .findMany({
          where: { bulkJobId: jobId },
          orderBy: { changedAt: 'asc' },
          limit: 50,
        });

      ctx.send({
        data: { job, historySample },
      });
    } catch (err) {
      console.error('[BULK-REFRESH GET JOB]', err);
      ctx.internalServerError('Failed to load job');
    }
  },

  /**
   * GET /admin/marketplace/bulk-refresh/eligible-count
   * Query: { tool, recentExportThresholdDays? }
   * Live "X sites match" preview before the admin commits to an export.
   */
  async eligibleCount(ctx) {
    try {
      const { tool, recentExportThresholdDays } = ctx.query;
      validateTool(tool);
      const count = await bulkRefreshService.countEligibleForExport({
        tool,
        recentExportThresholdDays: parseInt(recentExportThresholdDays, 10),
      });
      ctx.send({ data: { count } });
    } catch (err) {
      console.error('[BULK-REFRESH ELIGIBLE-COUNT]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError('Failed to count eligible sites');
    }
  },

  /**
   * POST /admin/marketplace/bulk-refresh/export
   * Body: { tool, limit?, recentExportThresholdDays? }
   * Returns a CSV download. Advances last_<tool>_export_at on selected
   * rows and writes a bulk_refresh_jobs row with jobType='export'.
   */
  async export(ctx) {
    try {
      const { tool, limit, recentExportThresholdDays } = ctx.request.body || {};
      validateTool(tool);

      const result = await bulkRefreshService.exportCohort({
        tool,
        limit: parseInt(limit, 10),
        recentExportThresholdDays: parseInt(recentExportThresholdDays, 10),
        actor: getActor(ctx),
      });

      console.log(
        `[ADMIN ACTION] Bulk-refresh export jobId=${result.jobId} tool=${tool} count=${result.count}`
      );

      ctx.set('Content-Type', 'text/csv; charset=utf-8');
      ctx.set('Content-Disposition', `attachment; filename="${result.filename}"`);
      ctx.set('X-Bulk-Refresh-Job-Id', String(result.jobId));
      ctx.set('X-Bulk-Refresh-Count', String(result.count));
      ctx.body = result.csvText;
    } catch (err) {
      console.error('[BULK-REFRESH EXPORT]', err);
      if (err.status === 400) return ctx.badRequest(err.message);
      ctx.internalServerError(err.message || 'Export failed');
    }
  },

  /**
   * GET /admin/marketplace/bulk-refresh/profiles
   * Returns the tool profiles (allowed fields, batch caps, hints).
   * Lets the frontend mirror server's tool list / bounds without
   * hardcoding.
   */
  async profiles(ctx) {
    const out = {};
    for (const tool of listTools()) {
      const p = getProfile(tool);
      out[tool] = {
        label: p.label,
        batchCap: p.batchCap,
        allowedFields: p.allowedFields,
        fieldBounds: p.fieldBounds,
        siteExplorerHints: p.siteExplorerHints,
      };
    }
    ctx.send({ data: out });
  },
};
