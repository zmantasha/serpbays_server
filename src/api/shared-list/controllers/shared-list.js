'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const bcrypt = require('bcryptjs');
const { ALLOWED_COLUMNS, DEFAULT_VISIBLE_COLUMNS, projectWebsite } = require('../utils/projection');

module.exports = createCoreController('api::shared-list.shared-list', ({ strapi }) => ({

  /**
   * GET /api/shared-lists/:slug
   * Returns the public-safe projection of a shared list.
   * - Public lists: open to anyone (optional ?password= if list has one).
   * - Private lists: caller must be authenticated and present in sharedWith.
   */
  async findBySlug(ctx) {
    const { slug } = ctx.params;
    if (!slug) return ctx.badRequest('slug is required');

    const list = await strapi.db.query('api::shared-list.shared-list').findOne({
      where: { slug, archived: false },
      populate: {
        websites: true,
        sharedWith: { fields: ['id'] },
      },
    });

    if (!list) return ctx.notFound('List not found');

    // Expiry check.
    if (list.expiresAt && new Date(list.expiresAt).getTime() < Date.now()) {
      // ctx.send() resets status to 200 — set body + status separately.
      ctx.status = 410;
      ctx.body = { error: 'expired', message: 'This share link has expired.' };
      return;
    }

    // Private mode requires an authenticated, allowlisted user. The route
    // is registered with auth:false so that public lists are accessible
    // without a token; we verify the Bearer JWT manually here.
    if (list.accessMode === 'private') {
      let userId = ctx.state.user?.id || null;
      if (!userId) {
        const authHeader = ctx.request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          try {
            const token = authHeader.slice(7);
            const decoded = await strapi.plugins['users-permissions'].services.jwt.verify(token);
            userId = decoded?.id || null;
          } catch (_) {
            // invalid token — fall through to unauthorized
          }
        }
      }
      if (!userId) return ctx.unauthorized('Sign in required to view this list.');
      const allowed = (list.sharedWith || []).some((u) => u.id === userId);
      if (!allowed) return ctx.forbidden('This list is not shared with your account.');
    }

    // Optional password gate (any access mode).
    if (list.passwordHash) {
      const provided = ctx.query?.password;
      if (!provided) {
        ctx.status = 401;
        ctx.body = { error: 'password_required', message: 'Password required.' };
        return;
      }
      const ok = await bcrypt.compare(String(provided), list.passwordHash);
      if (!ok) {
        ctx.status = 401;
        ctx.body = { error: 'password_required', message: 'Incorrect password.' };
        return;
      }
    }

    // Fire-and-forget view tracking; never block the response on it.
    strapi.db.query('api::shared-list.shared-list')
      .update({
        where: { id: list.id },
        data: {
          viewCount: (list.viewCount || 0) + 1,
          lastViewedAt: new Date(),
        },
      })
      .catch((e) => strapi.log.warn(`[SHARED-LIST] view-count update failed: ${e.message}`));

    // Filter visibleColumns through the allowlist so admin typos can't
    // surface unexpected fields.
    const requestedColumns = Array.isArray(list.visibleColumns) && list.visibleColumns.length
      ? list.visibleColumns
      : DEFAULT_VISIBLE_COLUMNS;
    const visibleColumns = requestedColumns.filter((c) => ALLOWED_COLUMNS.has(c));

    // If snapshot mode is on AND a snapshot exists, serve the frozen rows
    // instead of computing from live marketplace data. Pricing/markup are
    // baked in at snapshot time so admins can lock the quote they sent.
    const snapshotInUse = list.snapshotEnabled === true && Array.isArray(list.snapshotData);
    const websites = snapshotInUse
      ? list.snapshotData
      : (list.websites || []).map((mp) => projectWebsite(list, mp));

    ctx.send({
      data: {
        name: list.name,
        description: list.description,
        slug: list.slug,
        accessMode: list.accessMode,
        customRules: list.customRules,
        visibleColumns,
        currency: list.currency || 'USD',
        allowSearch: !!list.allowSearch,
        allowFilter: !!list.allowFilter,
        allowDownload: !!list.allowDownload,
        websites,
        websiteCount: websites.length,
        // Surface that this is a frozen view so the customer UI can
        // optionally show a "as of <date>" hint.
        isSnapshot: snapshotInUse,
        snapshotTakenAt: snapshotInUse ? list.snapshotTakenAt : null,
      },
    });
  },
}));
