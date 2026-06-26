'use strict';

/**
 * reseller-code controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::reseller-code.reseller-code', ({ strapi }) => ({
  
  /**
   * Validate a reseller code
   * GET /api/reseller-codes/validate/:code
   */
  async validateCode(ctx) {
    try {
      const { code } = ctx.params;
      if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
        return ctx.send({ valid: false, message: 'Invalid or inactive code' });
      }

      // SECURITY:
      //   - Pre-fix populated `assignedTo` (full up_users row leak — same
      //     class as the project/communication CRITICAL findings). Narrowed
      //     to `assignedToName` only (denormalised cache on this content type).
      //   - Pre-fix returned `id`/`usageLimit`/`usedCount`/`remainingUses` on
      //     ANONYMOUS validate. That is a PUBLIC endpoint — a competitor
      //     could iterate codes and harvest assigned reseller names + usage
      //     stats. Response narrowed to `{valid, message}` for the anonymous
      //     caller; the publisher-website create flow uses the service's
      //     `validateCode` server-side and gets the full record there.
      //   - Note for ops: this endpoint is PUBLIC and unrate-limited; brute-
      //     force valid codes is possible (codes are 12-char base36 → ~62
      //     bits, infeasible to brute-force but not impossible if codes are
      //     short or sequential). Recommend adding a per-IP rate limit
      //     middleware (~10 req/min/IP).
      const resellerCode = await strapi.db.query('api::reseller-code.reseller-code').findMany({
        where: { code, isActive: true },
        select: ['id', 'code', 'usageLimit', 'usedCount', 'expiresAt'],
      });

      if (!resellerCode || resellerCode.length === 0) {
        return ctx.send({ valid: false, message: 'Invalid or inactive code' });
      }

      const codeData = resellerCode[0];

      if (codeData.expiresAt && new Date(codeData.expiresAt) < new Date()) {
        return ctx.send({ valid: false, message: 'Code has expired' });
      }
      if (codeData.usageLimit !== null && codeData.usedCount >= codeData.usageLimit) {
        return ctx.send({ valid: false, message: 'Code usage limit exceeded' });
      }

      return ctx.send({ valid: true, message: 'Valid code' });

    } catch (error) {
      strapi.log?.error?.('[reseller-code] validateCode failed', { error: error.message });
      return ctx.internalServerError('Error validating code');
    }
  },

  /**
   * Use a reseller code (increment usage count)
   * POST /api/reseller-codes/use/:code
   */
  async useCode(ctx) {
    try {
      const { code } = ctx.params;
      const user = ctx.state.user;

      if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
        return ctx.badRequest('Invalid or inactive code');
      }
      if (!user) {
        return ctx.unauthorized('User not authenticated');
      }

      // SECURITY (pre-fix → post-fix):
      //   The pre-fix flow was read-then-write WITHOUT a row lock:
      //     1. SELECT usedCount FROM reseller_codes WHERE code = ?
      //     2. if (usedCount >= usageLimit) reject
      //     3. UPDATE SET usedCount = usedCount + 1
      //   Two concurrent calls passed the (2) check on the same snapshot
      //   and both incremented — exceeding `usageLimit` by N. If the code
      //   grants something (wallet bonus, discount), N attackers each get
      //   the benefit. Now atomic: row lock + CAS-style conditional UPDATE
      //   in one transaction.
      const result = await strapi.db.transaction(async ({ trx }) => {
        const rows = await trx('reseller_codes')
          .where({ code, is_active: true })
          .forUpdate()
          .select('*');
        if (!rows || rows.length === 0) {
          return { httpKind: 'badRequest', message: 'Invalid or inactive code' };
        }
        const row = rows[0];
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
          return { httpKind: 'badRequest', message: 'Code has expired' };
        }
        if (row.usage_limit !== null && row.used_count >= row.usage_limit) {
          return { httpKind: 'badRequest', message: 'Code usage limit exceeded' };
        }
        const newCount = row.used_count + 1;
        await trx('reseller_codes')
          .where({ id: row.id })
          .update({
            used_count: newCount,
            last_used_at: new Date(),
            last_used_by: user.id,
            updated_at: new Date(),
          });
        return {
          httpKind: 'ok',
          newCount,
          remainingUses: row.usage_limit ? (row.usage_limit - newCount) : null,
        };
      });

      if (result.httpKind === 'badRequest') {
        return ctx.badRequest(result.message);
      }

      return ctx.send({
        success: true,
        message: 'Code used successfully',
        data: {
          usedCount: result.newCount,
          remainingUses: result.remainingUses,
        },
      });

    } catch (error) {
      strapi.log?.error?.('[reseller-code] useCode failed', { error: error.message });
      return ctx.internalServerError('Error using code');
    }
  },

  /**
   * Get usage statistics for a reseller code
   * GET /api/reseller-codes/stats/:code
   */
  // Reseller-code statistics — restricted to admins OR the user the code
  // is assigned to. Pre-fix any authenticated user could hit this with any
  // code string and see the full list of publisher_website rows that used
  // it (id, url, submissionStatus, createdAt) — competitor reconnaissance
  // of which domains a given reseller channel has onboarded. Also leaked
  // assignedTo.username via the populated user.
  async getCodeStats(ctx) {
    try {
      const { code } = ctx.params;
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized();
      if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
        return ctx.notFound('Code not found');
      }

      const resellerCode = await strapi.db.query('api::reseller-code.reseller-code').findMany({
        where: { code },
        populate: { assignedTo: { select: ['id'] } },
      });
      if (!resellerCode || resellerCode.length === 0) {
        return ctx.notFound('Code not found');
      }
      const codeData = resellerCode[0];

      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
      const isAssignee = codeData.assignedTo && codeData.assignedTo.id === user.id;
      if (!isAdmin && !isAssignee) {
        // 404 (not 403) — defeat code enumeration via differential.
        return ctx.notFound('Code not found');
      }

      const websites = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: { resellerCode: code },
        fields: ['id', 'url', 'submissionStatus', 'createdAt'],
      });

      return ctx.send({
        code: codeData.code,
        assignedTo: codeData.assignedToName || null,
        isActive: codeData.isActive,
        usageLimit: codeData.usageLimit,
        usedCount: codeData.usedCount,
        remainingUses: codeData.usageLimit ? (codeData.usageLimit - codeData.usedCount) : null,
        expiresAt: codeData.expiresAt,
        lastUsedAt: codeData.lastUsedAt,
        websitesAdded: websites.length,
        websites,
      });

    } catch (error) {
      strapi.log?.error?.('[reseller-code] getCodeStats failed', { error: error.message });
      return ctx.internalServerError('Error getting code statistics');
    }
  }

}));
