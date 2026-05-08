'use strict';

/**
 * Admin Emails — admin panel controller for sending free-form transactional
 * emails to users/publishers/advertisers, and listing the audit log.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const parseRecipientField = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  }
  if (isPlainObject(value)) return [value];
  return [];
};

module.exports = createCoreController('api::admin-email.admin-email', ({ strapi }) => ({

  /**
   * POST /admin/emails/send
   * Body: { to, cc?, bcc?, subject, bodyHtml, context? : { type, ids } }
   */
  async send(ctx) {
    const adminUser = ctx.state.user;
    if (!adminUser) {
      return ctx.unauthorized('Admin authentication required');
    }

    const body = (ctx.request && ctx.request.body) || {};
    const {
      to,
      cc,
      bcc,
      subject,
      bodyHtml,
      context,
    } = body;

    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return ctx.badRequest('Subject is required');
    }
    if (!bodyHtml || typeof bodyHtml !== 'string' || !bodyHtml.trim()) {
      return ctx.badRequest('Email body is required');
    }

    const toList = parseRecipientField(to);
    const ccList = parseRecipientField(cc);
    const bccList = parseRecipientField(bcc);

    if (toList.length === 0) {
      return ctx.badRequest('At least one recipient is required');
    }

    const ctxType =
      isPlainObject(context) && typeof context.type === 'string'
        ? context.type
        : 'none';
    const rawIds =
      isPlainObject(context) && Array.isArray(context.ids)
        ? context.ids
        : isPlainObject(context) && context.id != null
          ? [context.id]
          : [];

    try {
      const log = await strapi
        .service('api::admin-email.admin-email')
        .sendAdminEmail({
          to: toList,
          cc: ccList,
          bcc: bccList,
          subject,
          bodyHtml,
          senderAdminId: adminUser.id,
          contextType: ctxType,
          contextIds: rawIds,
        });

      return {
        data: {
          id: log.id,
          status: log.status,
          providerMessageId: log.providerMessageId || null,
          sentAt: log.updatedAt,
        },
      };
    } catch (error) {
      strapi.log.error('[admin-emails] send failed', {
        adminId: adminUser.id,
        error: error.message,
      });
      const status = error.code === 'ADMIN_EMAIL_SEND_FAILED' ? 502 : 400;
      return ctx.send(
        {
          error: {
            status,
            name: error.code === 'ADMIN_EMAIL_SEND_FAILED' ? 'EmailProviderError' : 'BadRequest',
            message: error.message,
            details: error.logId ? { logId: error.logId } : undefined,
          },
        },
        status
      );
    }
  },

  /**
   * GET /admin/emails
   * List sent admin emails for audit.
   */
  async find(ctx) {
    try {
      const {
        page = 1,
        pageSize = 20,
        sort = 'createdAt:desc',
        status = '',
        contextType = '',
        senderAdmin = '',
        search = '',
      } = ctx.query;

      const filters = {};
      if (status) filters.status = status;
      if (contextType) filters.contextType = contextType;
      if (senderAdmin) filters.senderAdmin = senderAdmin;
      if (search) {
        filters.$or = [
          { subject: { $containsi: search } },
          { fromAddress: { $containsi: search } },
        ];
      }

      const pageNum = parseInt(page, 10) || 1;
      const sizeNum = Math.min(parseInt(pageSize, 10) || 20, 100);
      const start = (pageNum - 1) * sizeNum;

      const [rows, total] = await Promise.all([
        strapi.entityService.findMany('api::admin-email.admin-email', {
          filters,
          sort,
          start,
          limit: sizeNum,
          populate: ['senderAdmin'],
        }),
        strapi.db.query('api::admin-email.admin-email').count({ where: filters }),
      ]);

      return {
        data: rows,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: sizeNum,
            pageCount: Math.ceil(total / sizeNum),
            total,
          },
        },
      };
    } catch (error) {
      strapi.log.error('[admin-emails] find failed', { error: error.message });
      return ctx.internalServerError('Failed to list admin emails');
    }
  },

  /**
   * GET /admin/emails/:id
   */
  async findOne(ctx) {
    const { id } = ctx.params;
    try {
      const row = await strapi.entityService.findOne(
        'api::admin-email.admin-email',
        id,
        { populate: ['senderAdmin'] }
      );
      if (!row) return ctx.notFound('Email log not found');
      return { data: row };
    } catch (error) {
      strapi.log.error('[admin-emails] findOne failed', { id, error: error.message });
      return ctx.internalServerError('Failed to fetch email log');
    }
  },
}));
