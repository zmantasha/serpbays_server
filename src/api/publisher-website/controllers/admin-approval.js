'use strict';

/**
 * Admin approval controller for handling manual approvals
 */

module.exports = {
  // Manual approval endpoint that can be called from admin panel or scripts
  async manualApprove(ctx) {
    try {
      const { id } = ctx.params;
      
      console.log('🔄 Manual approval triggered for website ID:', id);
      
      // Get the current submission
      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!submission) {
        return ctx.notFound('Website submission not found');
      }
      
      console.log('Found submission:', submission.url);
      
      // Update submission status if not already approved
      let updatedSubmission = submission;
      if (submission.submissionStatus !== 'approved') {
        updatedSubmission = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
          data: {
            submissionStatus: 'approved',
            reviewedAt: new Date(),
            reviewedBy: 'manual-approval',
            approvedAt: new Date(),
            reviewNotes: 'Approved manually through admin interface'
          }
        });
        console.log('✅ Submission status updated to approved');
      }
      
      // Create marketplace listing
      const controller = strapi.controller('api::publisher-website.publisher-website');
      if (controller && controller.createMarketplaceListing) {
        try {
          await controller.createMarketplaceListing(updatedSubmission);
          console.log('✅ Marketplace listing created successfully');
        } catch (marketplaceError) {
          console.error('❌ Error creating marketplace listing:', marketplaceError);
          return ctx.badRequest('Approval successful but marketplace creation failed: ' + marketplaceError.message);
        }
      } else {
        console.error('❌ createMarketplaceListing method not found');
        return ctx.internalServerError('createMarketplaceListing method not available');
      }
      
      return ctx.send({
        message: 'Website approved successfully and added to marketplace',
        data: updatedSubmission
      });
      
    } catch (error) {
      console.error('Error in manual approval:', error);
      return ctx.internalServerError('Failed to approve website: ' + error.message);
    }
  },

  // Get approval status
  async getApprovalStatus(ctx) {
    try {
      const { id } = ctx.params;
      
      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!submission) {
        return ctx.notFound('Website submission not found');
      }
      
      // Check if marketplace listing exists
      const marketplaceListing = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters: { url: submission.url }
      });
      
      return ctx.send({
        submissionStatus: submission.submissionStatus,
        hasMarketplaceListing: marketplaceListing && marketplaceListing.length > 0,
        marketplaceId: submission.marketplaceId,
        approvedAt: submission.approvedAt,
        reviewedBy: submission.reviewedBy
      });
      
    } catch (error) {
      console.error('Error getting approval status:', error);
      return ctx.internalServerError('Failed to get approval status');
    }
  }
};
