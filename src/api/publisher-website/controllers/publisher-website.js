'use strict';

/**
 * publisher-website controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::publisher-website.publisher-website', ({ strapi }) => ({
  // Create new publisher website submission
  async create(ctx) {
    try {
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      // Validate that user is authenticated
      if (!user) {
        return ctx.unauthorized('You must be logged in to submit a website.');
      }

      // Check if this URL already exists for this publisher
      const existingSubmission = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: {
          url: data.url,
          publisherEmail: user.email
        }
      });

      if (existingSubmission && existingSubmission.length > 0) {
        // Update existing submission
        const updated = await strapi.entityService.update('api::publisher-website.publisher-website', existingSubmission[0].id, {
          data: {
            ...data,
            publisherEmail: user.email,
            publisherName: user.username || user.email,
            submissionStatus: data.gscVerified ? 'verified_pending_review' : 'pending_verification',
            publishedAt: new Date()
          }
        });

        return { data: updated };
      } else {
        // Create new submission
        const submission = await strapi.entityService.create('api::publisher-website.publisher-website', {
          data: {
            ...data,
            publisherEmail: user.email,
            publisherName: user.username || user.email,
            submissionStatus: data.gscVerified ? 'verified_pending_review' : 'pending_verification',
            publishedAt: new Date()
          }
        });

        return { data: submission };
      }
    } catch (error) {
      console.error('Error creating publisher website submission:', error);
      return ctx.internalServerError('Failed to submit website');
    }
  },

  // Get publisher's website submissions
  async find(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to view your websites.');
      }

      const submissions = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: {
          publisherEmail: user.email
        },
        sort: { createdAt: 'desc' },
        populate: '*'
      });

      return { data: submissions };
    } catch (error) {
      console.error('Error fetching publisher websites:', error);
      return ctx.internalServerError('Failed to fetch websites');
    }
  },

  // Update existing submission
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to update a website.');
      }

      // Check if this submission belongs to the user
      const existing = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!existing || existing.publisherEmail !== user.email) {
        return ctx.forbidden('You can only update your own website submissions.');
      }

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          ...data,
          submissionStatus: data.gscVerified ? 'verified_pending_review' : 'pending_verification'
        }
      });

      return { data: updated };
    } catch (error) {
      console.error('Error updating publisher website:', error);
      return ctx.internalServerError('Failed to update website');
    }
  },

  // Admin action: Approve website submission
  async approve(ctx) {
    try {
      console.log('=== APPROVAL PROCESS STARTED ===');
      const { id } = ctx.params;
      const user = ctx.state.user;
      console.log('Approving submission ID:', id);
      console.log('User:', user?.email || 'No user found');

      // Check if user is admin (you may need to adjust this based on your admin role setup)
      if (!user || user.role?.type !== 'admin') {
        return ctx.forbidden('Only administrators can approve websites.');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      console.log('Found submission:', submission?.url || 'No submission found');
      
      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      // Update submission status to approved
      console.log('Updating submission status to approved...');
      const approved = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'approved',
          reviewedAt: new Date(),
          reviewedBy: user?.email || 'system',
          reviewNotes: ctx.request.body.reviewNotes || 'Approved by admin',
          approvedAt: new Date()
        }
      });
      console.log('Submission updated:', approved.submissionStatus);

      // Create marketplace entry
      console.log('Creating marketplace listing...');
      try {
        const marketplaceListing = await this.createMarketplaceListing(approved);
        console.log('Marketplace listing created successfully:', marketplaceListing?.id);
      } catch (marketplaceError) {
        console.error('Failed to create marketplace listing:', marketplaceError);
        // Don't fail the approval if marketplace creation fails
      }

      // TODO: Send approval email notification
      console.log('=== APPROVAL PROCESS COMPLETED ===');
      
      return { data: approved, message: 'Website approved and added to marketplace' };
    } catch (error) {
      console.error('Error approving website:', error);
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
      return ctx.internalServerError('Failed to approve website');
    }
  },

  // Admin action: Reject website submission
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { rejectionReason } = ctx.request.body;
      const user = ctx.state.user;

      if (!user || user.role?.type !== 'admin') {
        return ctx.forbidden('Only administrators can reject websites.');
      }

      if (!rejectionReason) {
        return ctx.badRequest('Rejection reason is required');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      const rejected = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'rejected',
          reviewedAt: new Date(),
          reviewedBy: user.email,
          rejectionReason,
          reviewNotes: ctx.request.body.reviewNotes || ''
        }
      });

      // TODO: Send rejection email notification
      
      return { data: rejected, message: 'Website rejected' };
    } catch (error) {
      console.error('Error rejecting website:', error);
      return ctx.internalServerError('Failed to reject website');
    }
  },

  // Admin action: Request changes to submission
  async requestChanges(ctx) {
    try {
      const { id } = ctx.params;
      const { changeRequests, reviewNotes } = ctx.request.body;
      const user = ctx.state.user;

      if (!user || user.role?.type !== 'admin') {
        return ctx.forbidden('Only administrators can request changes.');
      }

      if (!changeRequests) {
        return ctx.badRequest('Change requests are required');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'requires_changes',
          reviewedAt: new Date(),
          reviewedBy: user.email,
          changeRequests,
          reviewNotes: reviewNotes || ''
        }
      });

      // TODO: Send change request email notification
      
      return { data: updated, message: 'Change requests sent to publisher' };
    } catch (error) {
      console.error('Error requesting changes:', error);
      return ctx.internalServerError('Failed to request changes');
    }
  },

  // Admin action: Mark submission as under review
  async markUnderReview(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user || user.role?.type !== 'admin') {
        return ctx.forbidden('Only administrators can update review status.');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'under_review',
          reviewStartedAt: new Date(),
          reviewedBy: user.email,
          reviewNotes: ctx.request.body.reviewNotes || 'Under detailed review'
        }
      });
      
      return { data: updated, message: 'Submission marked as under review' };
    } catch (error) {
      console.error('Error marking under review:', error);
      return ctx.internalServerError('Failed to update review status');
    }
  },



  // Helper function: Create marketplace listing from approved submission
  async createMarketplaceListing(submission) {
    try {
      console.log('Creating marketplace listing for submission:', submission.url);
      
      // Check if marketplace listing already exists
      const existingListing = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters: {
          url: submission.url
        }
      });

      // Map publisher-website fields to marketplace fields
      const marketplaceData = {
        url: submission.url,
        price: submission.advertiserPrice,
        link_insertion_price: submission.advertiserPrice, // Default to same as guest post price
        min_word_count: submission.minWordCount,
        backlink_type: submission.backlinkType,
        category: submission.categories,
        guidelines: submission.guidelines,
        backlink_validity: 'Permanent', // Default value
        publisher_name: submission.publisherName || submission.publisherEmail.split('@')[0],
        publisher_email: submission.publisherEmail,
        publisher_price: submission.publisherEarnings,
        fast_placement_status: submission.fastPlacement || false,
        countries: submission.countries,
        language: submission.languages,
        website_status: 'active',
        gsc_verified: submission.gscVerified || false,
        gsc_verified_at: submission.gscVerifiedAt,
        gsc_permission_level: submission.gscPermissionLevel,
        placement_speed: submission.fastPlacement ? 'Fast' : 'Normal',
        tat: 7, // Default 7 days
        publishedAt: new Date()
      };

      if (existingListing && existingListing.length > 0) {
        console.log('Updating existing marketplace listing:', existingListing[0].id);
        // Update existing listing
        const updated = await strapi.entityService.update('api::marketplace.marketplace', existingListing[0].id, {
          data: marketplaceData
        });
        
        // Store marketplace ID in publisher-website submission
        await strapi.entityService.update('api::publisher-website.publisher-website', submission.id, {
          data: { marketplaceId: updated.id }
        });
        
        return updated;
      } else {
        console.log('Creating new marketplace listing');
        // Create new marketplace listing
        const created = await strapi.entityService.create('api::marketplace.marketplace', {
          data: marketplaceData
        });
        
        // Store marketplace ID in publisher-website submission
        await strapi.entityService.update('api::publisher-website.publisher-website', submission.id, {
          data: { marketplaceId: created.id }
        });
        
        console.log('Successfully created marketplace listing with ID:', created.id);
        return created;
      }
    } catch (error) {
      console.error('Error creating marketplace listing:', error);
      console.error('Error details:', error.message);
      console.error('Submission data:', JSON.stringify(submission, null, 2));
      throw error;
    }
  }
}));
