'use strict';

/**
 * Admin Website Transfer Controller
 *
 * Direct admin transfer.
 *
 * - The ORIGINAL website record is preserved with its previous owner
 *   intact and submissionStatus flipped to "ownership_transferred", so
 *   the old publisher's history (orders, metrics) stays attached to it.
 * - A NEW website record is cloned for the target user. Because the
 *   admin is acting as the source of truth, the new record skips the
 *   GSC verification step and is set to "approved" immediately.
 * - The old record points at the new one via `newOwnerWebsiteId`.
 * - Only the previous owner is notified by email.
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Fields that must NOT be carried over when cloning a website record.
const NON_CLONEABLE_FIELDS = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  // Strapi v5 entity-service relation arrays we don't want to deep-copy
  'updateRequests',
  // ownership/claim metadata — set explicitly
  'currentPublisherId',
  'originalPublisherId',
  'claimedBy',
  'claimedAt',
  'claimedFrom',
  'claimSubmittedAt',
  'claimingInProgress',
  'originalWebsiteId',
  'newOwnerWebsiteId',
  'ownershipTransferredAt',
  'ownershipTransferReason',
  // GSC verification — we skip GSC entirely
  'gscVerified',
  'gscVerifiedAt',
  'gscPermissionLevel',
  'gscRefreshToken',
  // Approval/review metadata — set explicitly on the clone
  'submissionStatus',
  'approvedAt',
  'reviewedAt',
  'reviewedBy',
  'reviewStartedAt',
  'reviewNotes',
  'rejectionReason',
  'changeRequests',
  // Identifying fields we override
  'publisherEmail',
  'publisherName'
]);

const cloneWebsiteFields = (source) => {
  const clone = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (NON_CLONEABLE_FIELDS.has(key)) continue;
    clone[key] = value;
  }
  return clone;
};

/**
 * Performs a single ownership transfer. Returns { result, error }.
 */
async function performTransfer({ strapi, websiteId, targetUser, reason }) {
  const website = await strapi.entityService.findOne(
    'api::publisher-website.publisher-website',
    websiteId,
    { populate: ['currentPublisherId', 'originalPublisherId'] }
  );
  if (!website) return { error: 'Website not found' };

  // Only fully-approved (or admin-paused) records can be transferred.
  // Anything still in the submission/review pipeline is not yet a real
  // listing, and rejected/claimed records have their own lifecycle.
  const TRANSFERABLE_STATUSES = new Set(['approved', 'listing_paused']);
  if (!TRANSFERABLE_STATUSES.has(website.submissionStatus)) {
    const statusMessages = {
      ownership_transferred:
        'This website has already been transferred. Transfer the new record instead.',
      ownership_claimed:
        'This website is currently being claimed by another user. Wait for the claim review to complete before transferring.',
      rejected:
        'This website was rejected and cannot be transferred.',
      pending_verification:
        'This website is still pending verification. Wait until it has been approved before transferring.',
      pending_final_submission:
        'This website has not been submitted for review yet. Wait until it has been approved before transferring.',
      approval_pending:
        'This website is still pending admin review. Wait until it has been approved before transferring.'
    };
    return {
      error:
        statusMessages[website.submissionStatus] ||
        `This website cannot be transferred while its status is "${website.submissionStatus}". Only approved websites can be transferred.`,
      website
    };
  }

  const previousOwner =
    website.currentPublisherId || website.originalPublisherId;

  if (previousOwner && previousOwner.id === targetUser.id) {
    return { error: 'Target user is already the current owner', website };
  }

  const cloneable = cloneWebsiteFields(website);
  const now = new Date();

  let newWebsiteId = null;

  await strapi.db.transaction(async () => {
    // 1. Create the new owner's record (clone of current website data).
    const newWebsite = await strapi.entityService.create(
      'api::publisher-website.publisher-website',
      {
        data: {
          ...cloneable,
          publisherEmail: targetUser.email,
          publisherName: targetUser.username || targetUser.email,
          currentPublisherId: targetUser.id,
          originalPublisherId: previousOwner ? previousOwner.id : null,
          originalWebsiteId: website.id,
          claimedFrom: previousOwner?.email || website.publisherEmail || null,
          claimedAt: now,
          ownershipTransferredAt: now,
          ownershipTransferReason: 'admin_transfer',
          // Skip GSC entirely — admin is the source of truth.
          verificationMethod: null,
          gscVerified: false,
          gscVerifiedAt: null,
          // Auto-approved (no extra review step).
          submissionStatus: 'approved',
          approvedAt: now,
          stepCompleted: 4
        }
      }
    );

    newWebsiteId = newWebsite.id;

    // 2. Mark the original record as transferred. Keep the previous
    //    owner and historical data untouched.
    await strapi.entityService.update(
      'api::publisher-website.publisher-website',
      website.id,
      {
        data: {
          submissionStatus: 'ownership_transferred',
          ownershipTransferredAt: now,
          ownershipTransferReason: 'admin_transfer',
          newOwnerWebsiteId: newWebsite.id
        }
      }
    );

    // 3. Re-point the marketplace listing(s) for this URL at the new
    //    owner. Order creation reads marketplace.publisher /
    //    publisher_email / publisher_name, so without this the new
    //    orders would still flow to the previous owner.
    if (website.url) {
      try {
        const matchingMarketplaces = await strapi.db
          .query('api::marketplace.marketplace')
          .findMany({
            where: { url: website.url }
          });

        for (const m of matchingMarketplaces) {
          await strapi.db.query('api::marketplace.marketplace').update({
            where: { id: m.id },
            data: {
              publisher: targetUser.id,
              publisher_email: targetUser.email,
              publisher_name: targetUser.username || targetUser.email
            }
          });
        }
        console.log(
          `[ADMIN TRANSFER] Re-pointed ${matchingMarketplaces.length} marketplace listing(s) for ${website.url} to user ${targetUser.id}`
        );
      } catch (mErr) {
        console.error(
          `[ADMIN TRANSFER] Failed to re-point marketplace listing for ${website.url}:`,
          mErr
        );
        // Re-throw so the db.transaction rolls back — leaving an
        // inconsistent owner on the marketplace would silently route
        // orders to the wrong publisher.
        throw mErr;
      }
    }
  });

  return {
    result: {
      originalWebsiteId: website.id,
      newWebsiteId,
      previousOwnerId: previousOwner?.id || null,
      newOwnerId: targetUser.id,
      previousOwner
    },
    website
  };
}

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

        const targetUser = await strapi.db
          .query('plugin::users-permissions.user')
          .findOne({ where: { id: targetId } });
        if (!targetUser) {
          return ctx.badRequest(`No user found with id ${targetId}.`);
        }

        const { error, result, website } = await performTransfer({
          strapi,
          websiteId,
          targetUser,
          reason
        });
        if (error) return ctx.badRequest(error);

        console.log(
          `[ADMIN TRANSFER] Website ${websiteId} → new record ${result.newWebsiteId} for user ${targetUser.id} (admin ${admin?.id})`
        );

        // Notify previous owner only (non-fatal). Use the same generic
        // Website Status template the GSC-claim transfer flow uses, so
        // both transfer paths produce a single, identical email.
        try {
          if (result.previousOwner?.email) {
            await strapi
              .service('api::global.email-operations')
              .sendWebsiteStatusEmail({
                publisherEmail: result.previousOwner.email,
                publisherName:
                  result.previousOwner.username || result.previousOwner.email,
                websiteName: website?.url,
                websiteUrl: website?.url,
                actionType: 'Transferred',
                notes:
                  reason ||
                  'Ownership of this website has been transferred to a new owner. Any existing orders remain assigned to you, and you are responsible for completing them and receiving payment. All new orders will be routed to the new owner.'
              });
          }
        } catch (emailErr) {
          console.error('[ADMIN TRANSFER] Notification email failed:', emailErr);
        }

        return {
          data: {
            originalWebsiteId: result.originalWebsiteId,
            newWebsiteId: result.newWebsiteId,
            previousOwnerId: result.previousOwnerId,
            newOwnerId: result.newOwnerId
          },
          meta: {
            message: result.previousOwner
              ? `New website record created for ${targetUser.email}. Previous owner (${result.previousOwner.email}) notified.`
              : `New website record created for ${targetUser.email}.`
          }
        };
      } catch (error) {
        console.error('[ADMIN TRANSFER] transferOwnership error:', error);
        return ctx.internalServerError('Failed to transfer ownership');
      }
    },

    /**
     * POST /admin/websites/bulk-transfer-ownership
     * Body: { websiteIds: number[], targetUserId, reason? }
     *
     * Best-effort: each website is processed independently. Failures
     * for one website do not abort the others. One email is sent to
     * each previous owner per successful transfer.
     */
    async bulkTransferOwnership(ctx) {
      try {
        const { websiteIds, targetUserId, reason } = ctx.request.body || {};
        const admin = ctx.state.user;

        if (!Array.isArray(websiteIds) || websiteIds.length === 0) {
          return ctx.badRequest('websiteIds must be a non-empty array');
        }

        const targetId = parseInt(targetUserId, 10);
        if (!targetId || Number.isNaN(targetId)) {
          return ctx.badRequest('targetUserId is required');
        }

        const targetUser = await strapi.db
          .query('plugin::users-permissions.user')
          .findOne({ where: { id: targetId } });
        if (!targetUser) {
          return ctx.badRequest(`No user found with id ${targetId}.`);
        }

        console.log(
          `[ADMIN BULK TRANSFER] Admin ${admin?.id} transferring ${websiteIds.length} websites to user ${targetId}`
        );

        const results = [];
        const errors = [];
        const emailService = strapi.service('api::global.email-operations');

        for (const rawId of websiteIds) {
          const websiteId = parseInt(rawId, 10);
          if (!websiteId || Number.isNaN(websiteId)) {
            errors.push({ id: rawId, error: 'Invalid website id' });
            continue;
          }

          try {
            const { error, result, website } = await performTransfer({
              strapi,
              websiteId,
              targetUser,
              reason
            });

            if (error) {
              errors.push({ id: websiteId, url: website?.url || null, error });
              continue;
            }

            results.push({
              id: websiteId,
              url: website?.url || null,
              originalWebsiteId: result.originalWebsiteId,
              newWebsiteId: result.newWebsiteId,
              previousOwnerId: result.previousOwnerId,
              newOwnerId: result.newOwnerId
            });

            // One email per transfer (non-fatal). Match the single-
            // transfer path: use the shared Website Status template.
            try {
              if (result.previousOwner?.email) {
                await emailService.sendWebsiteStatusEmail({
                  publisherEmail: result.previousOwner.email,
                  publisherName:
                    result.previousOwner.username ||
                    result.previousOwner.email,
                  websiteName: website?.url,
                  websiteUrl: website?.url,
                  actionType: 'Transferred',
                  notes:
                    reason ||
                    'Ownership of this website has been transferred to a new owner. Any existing orders remain assigned to you, and you are responsible for completing them and receiving payment. All new orders will be routed to the new owner.'
                });
              }
            } catch (emailErr) {
              console.error(
                `[ADMIN BULK TRANSFER] Email failed for website ${websiteId}:`,
                emailErr
              );
            }
          } catch (rowError) {
            console.error(
              `[ADMIN BULK TRANSFER] Failed to transfer website ${websiteId}:`,
              rowError
            );
            errors.push({
              id: websiteId,
              error: rowError?.message || 'Failed to transfer ownership'
            });
          }
        }

        console.log(
          `[ADMIN BULK TRANSFER] Done: ${results.length} successful, ${errors.length} failed`
        );

        return ctx.send({
          message: `Bulk transfer completed: ${results.length} successful, ${errors.length} failed`,
          newOwner: {
            id: targetUser.id,
            username: targetUser.username,
            email: targetUser.email
          },
          results,
          errors
        });
      } catch (error) {
        console.error('[ADMIN BULK TRANSFER] error:', error);
        return ctx.internalServerError('Failed to bulk transfer ownership');
      }
    }
  })
);
