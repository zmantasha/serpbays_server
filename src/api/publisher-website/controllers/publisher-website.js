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
  }
}));
