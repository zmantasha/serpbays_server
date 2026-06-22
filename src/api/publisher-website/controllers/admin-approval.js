'use strict';

/**
 * Admin approval controller for handling manual approvals.
 *
 * SECURITY hardening (workflow IDs mw-find-manualApprove-no-admin-check,
 * idor-publisher-approval-status, idor-publisher-manual-approve):
 *
 *   - manualApprove: pre-fix had NO in-handler auth or admin check.
 *     The route also had no policies/middlewares — only `description`.
 *     Defense relied entirely on `up_permissions` granting the
 *     `admin-approval.manualApprove` action to super_admin only. If a
 *     future permission grant change widened access (or a route-config
 *     edit added a wider scope), any authenticated user could approve
 *     any publisher website → marketplace listing creation → publisher
 *     gets a live revenue path on someone else's domain. Defense-in-
 *     depth admin check added at handler entry.
 *
 *   - getApprovalStatus: pre-fix had NO in-handler auth and NO ownership
 *     check. The Authenticated role HAS the grant (per up_permissions),
 *     so any logged-in user could GET /publisher-websites/<N>/approval-status
 *     and read submissionStatus / approvedAt / reviewedBy / marketplaceId
 *     for any website. Competitor-recon vector. Now: authenticated +
 *     (admin OR site owner) only; 404 on cross-tenant to defeat
 *     submission-id enumeration.
 *
 *   - Both handlers no longer echo error.message — server-side log only.
 */

function isAdminUser(user) {
  return user && user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
}

module.exports = {
  async manualApprove(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized('Authentication required');
      if (!isAdminUser(user)) return ctx.forbidden('Admin access required');

      const { id } = ctx.params;
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Website submission not found');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', numericId);
      if (!submission) {
        return ctx.notFound('Website submission not found');
      }

      let updatedSubmission = submission;
      if (submission.submissionStatus !== 'approved') {
        updatedSubmission = await strapi.entityService.update('api::publisher-website.publisher-website', numericId, {
          data: {
            submissionStatus: 'approved',
            reviewedAt: new Date(),
            reviewedBy: 'manual-approval',
            approvedAt: new Date(),
            reviewNotes: 'Approved manually through admin interface',
          },
        });
      }

      const controller = strapi.controller('api::publisher-website.publisher-website');
      if (controller && controller.createMarketplaceListing) {
        try {
          await controller.createMarketplaceListing(updatedSubmission);
        } catch (marketplaceError) {
          strapi.log?.error?.('[admin-approval] marketplace creation failed', { error: marketplaceError.message });
          return ctx.badRequest('Approval successful but marketplace creation failed');
        }
      } else {
        strapi.log?.error?.('[admin-approval] createMarketplaceListing method not found');
        return ctx.internalServerError('createMarketplaceListing method not available');
      }

      try {
        const emailService = strapi.service('api::global.email-operations');
        if (updatedSubmission.publisherEmail) {
          await emailService.sendWebsiteStatusEmail({
            publisherEmail: updatedSubmission.publisherEmail,
            publisherName: updatedSubmission.publisherName || updatedSubmission.publisherEmail,
            websiteName: updatedSubmission.url,
            websiteUrl: updatedSubmission.url,
            actionType: 'Approved and Live',
          });
        }
      } catch (emailError) {
        strapi.log?.error?.('[admin-approval] approval email send failed', { error: emailError.message });
      }

      return ctx.send({
        message: 'Website approved successfully and added to marketplace',
        data: { id: updatedSubmission.id, submissionStatus: updatedSubmission.submissionStatus },
      });

    } catch (error) {
      strapi.log?.error?.('[admin-approval] manualApprove failed', { error: error.message });
      return ctx.internalServerError('Failed to approve website');
    }
  },

  async getApprovalStatus(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized('Authentication required');

      const { id } = ctx.params;
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Website submission not found');
      }

      const submission = await strapi.entityService.findOne(
        'api::publisher-website.publisher-website',
        numericId,
        { populate: { currentPublisherId: { fields: ['id'] } } }
      );
      if (!submission) {
        return ctx.notFound('Website submission not found');
      }

      // Ownership: admin OR the assigned publisher OR legacy unlinked
      // row matching the caller's email.
      const ownerId = submission.currentPublisherId?.id ?? submission.currentPublisherId ?? null;
      const isOwner =
        (ownerId != null && ownerId === user.id) ||
        (ownerId == null && submission.publisherEmail && submission.publisherEmail === user.email);
      if (!isAdminUser(user) && !isOwner) {
        // 404 — defeat submission-id enumeration via the differential.
        return ctx.notFound('Website submission not found');
      }

      const marketplaceListing = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters: { url: submission.url },
        fields: ['id'],
      });

      return ctx.send({
        submissionStatus: submission.submissionStatus,
        hasMarketplaceListing: marketplaceListing && marketplaceListing.length > 0,
        marketplaceId: submission.marketplaceId,
        approvedAt: submission.approvedAt,
        reviewedBy: submission.reviewedBy,
      });

    } catch (error) {
      strapi.log?.error?.('[admin-approval] getApprovalStatus failed', { error: error.message });
      return ctx.internalServerError('Failed to get approval status');
    }
  },
};
