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
      const { id } = ctx.params;
      const user = ctx.state.user;

      // Check if user is admin (you may need to adjust this based on your admin role setup)
      if (!user || user.role?.type !== 'admin') {
        return ctx.forbidden('Only administrators can approve websites.');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      
      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      // Update submission status to approved
      const approved = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'approved',
          reviewedAt: new Date(),
          reviewedBy: user.email,
          reviewNotes: ctx.request.body.reviewNotes || 'Approved by admin'
        }
      });

      // Create marketplace entry
      await this.createMarketplaceListing(approved);

      // TODO: Send approval email notification
      
      return { data: approved, message: 'Website approved and added to marketplace' };
    } catch (error) {
      console.error('Error approving website:', error);
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
      // Check if marketplace listing already exists
      const existingListing = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters: {
          url: submission.url
        }
      });

      if (existingListing && existingListing.length > 0) {
        // Update existing listing
        return await strapi.entityService.update('api::marketplace.marketplace', existingListing[0].id, {
          data: {
            url: submission.url,
            protocol: submission.protocol,
            websiteName: submission.url.replace(/^www\./, ''),
            websiteDescription: submission.description,
            websiteCategory: submission.categories,
            price: submission.advertiserPrice,
            publisher_price: submission.publisherEarnings,
            minWordCount: submission.minWordCount,
            deliveryTime: submission.deliveryTime,
            backlinkType: submission.backlinkType,
            languages: submission.languages,
            countries: submission.countries,
            fastPlacement: submission.fastPlacement,
            guidelines: submission.guidelines,
            website_status: 'active',
            gsc_verified: submission.gscVerified,
            gsc_verified_at: submission.gscVerifiedAt,
            publishedAt: new Date()
          }
        });
      } else {
        // Create new marketplace listing
        return await strapi.entityService.create('api::marketplace.marketplace', {
          data: {
            url: submission.url,
            protocol: submission.protocol,
            websiteName: submission.url.replace(/^www\./, ''),
            websiteDescription: submission.description,
            websiteCategory: submission.categories,
            price: submission.advertiserPrice,
            publisher_price: submission.publisherEarnings,
            minWordCount: submission.minWordCount,
            deliveryTime: submission.deliveryTime,
            backlinkType: submission.backlinkType,
            languages: submission.languages,
            countries: submission.countries,
            fastPlacement: submission.fastPlacement,
            guidelines: submission.guidelines,
            website_status: 'active',
            gsc_verified: submission.gscVerified,
            gsc_verified_at: submission.gscVerifiedAt,
            publishedAt: new Date()
          }
        });
      }
    } catch (error) {
      console.error('Error creating marketplace listing:', error);
      throw error;
    }
  }
}));
