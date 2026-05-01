'use strict';

/**
 * Admin Website Transfer Controller
 *
 * Direct admin transfer: admin selects a target user, ownership flips
 * immediately, only the previous owner is notified by email.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController(
  'api::publisher-website.publisher-website',
  ({ strapi }) => ({

    /**
     * POST /admin/websites/:id/transfer-ownership
     * Body: { targetUserId, reason? }
     */
    async transferOwnership(ctx) {
      try {
        const websiteId = parseInt(ctx.params.id, 10);
        const { targetUserId, reason } = ctx.request.body || {};
        const admin = ctx.state.user;

        if (!websiteId) return ctx.badRequest('Invalid website id');

        const targetId = parseInt(targetUserId, 10);
        if (!targetId || Number.isNaN(targetId)) {
          return ctx.badRequest('targetUserId is required');
        }

        // 1. Load website + current owner
        const website = await strapi.entityService.findOne(
          'api::publisher-website.publisher-website',
          websiteId,
          { populate: ['currentPublisherId', 'originalPublisherId'] }
        );
        if (!website) return ctx.notFound('Website not found');

        const previousOwner =
          website.currentPublisherId || website.originalPublisherId;

        // 2. Resolve target user
        const targetUser = await strapi.db
          .query('plugin::users-permissions.user')
          .findOne({ where: { id: targetId } });
        if (!targetUser) {
          return ctx.badRequest(`No user found with id ${targetId}.`);
        }

        // 3. Reject self-transfer
        if (previousOwner && targetUser.id === previousOwner.id) {
          return ctx.badRequest('Target user is already the current owner.');
        }

        // 4. Flip ownership atomically
        const updated = await strapi.db.transaction(async () => {
          return strapi.entityService.update(
            'api::publisher-website.publisher-website',
            websiteId,
            {
              data: {
                currentPublisherId: targetUser.id,
                publisherEmail: targetUser.email,
                publisherName: targetUser.username || targetUser.email,
                ownershipTransferredAt: new Date(),
                ownershipTransferReason: 'admin_transfer',
                submissionStatus: 'ownership_transferred'
              },
              populate: ['currentPublisherId']
            }
          );
        });

        console.log(
          `[ADMIN TRANSFER] Website ${websiteId} ownership flipped to user ${targetUser.id} by admin ${admin?.id}`
        );

        // 5. Notify the previous owner only (non-fatal)
        try {
          if (previousOwner?.email) {
            await strapi
              .service('api::global.email-operations')
              .sendWebsiteTransferOutEmail({
                website,
                previousOwner,
                newOwner: targetUser,
                reason: reason || null
              });
          }
        } catch (emailErr) {
          console.error('[ADMIN TRANSFER] Notification email failed:', emailErr);
        }

        return {
          data: {
            websiteId,
            previousOwnerId: previousOwner?.id || null,
            newOwnerId: targetUser.id,
            transferredAt: updated?.ownershipTransferredAt
          },
          meta: {
            message: previousOwner
              ? `Ownership transferred to ${targetUser.email}. Previous owner notified.`
              : `Ownership set to ${targetUser.email}.`
          }
        };
      } catch (error) {
        console.error('[ADMIN TRANSFER] transferOwnership error:', error);
        return ctx.internalServerError('Failed to transfer ownership');
      }
    }
  })
);
