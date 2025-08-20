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

  // Get single publisher website by ID
  async findOne(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to view website details.');
      }

      // First find the website
      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: '*'
      });

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Check if the website belongs to the current user
      if (website.publisherEmail !== user.email) {
        return ctx.forbidden('You can only view your own website submissions.');
      }

      return { data: website };
    } catch (error) {
      console.error('Error fetching publisher website:', error);
      return ctx.internalServerError('Failed to fetch website details');
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

      console.log("updated",updated)
      console.log("existing",existing)

      // If this is an approved website being updated, also update the marketplace
      // if (existing.submissionStatus === 'approved' && existing.marketplaceId) {
      //   console.log('Updating marketplace listing for approved website...');
      //   try {
      //     await this.createMarketplaceListing(updated);
      //     console.log('Marketplace listing updated successfully');
      //   } catch (marketplaceError) {
      //     console.error('Failed to update marketplace listing:', marketplaceError);
      //     // Don't fail the update if marketplace update fails
      //   }
      // }

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

      // Check if user is admin (flexible admin role checking)
      console.log('User role structure:', JSON.stringify(user?.role, null, 2));
      const isAdmin = user && user.role && (
        user.role.type === 'admin' || 
        user.role.name === 'Admin' || 
        user.role.name === 'Administrator' ||
        user.email === 'mantasha@wordscloud.in'  // Special admin access
      );
      
      if (!isAdmin) {
        console.log('Access denied. User role:', user?.role);
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

      const isAdmin = user && user.role && (
        user.role.type === 'admin' || 
        user.role.name === 'Admin' || 
        user.role.name === 'Administrator' ||
        user.email === 'mantasha@wordscloud.in'
      );
      
      if (!isAdmin) {
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

      const isAdmin = user && user.role && (
        user.role.type === 'admin' || 
        user.role.name === 'Admin' || 
        user.role.name === 'Administrator' ||
        user.email === 'mantasha@wordscloud.in'
      );
      
      if (!isAdmin) {
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

      const isAdmin = user && user.role && (
        user.role.type === 'admin' || 
        user.role.name === 'Admin' || 
        user.role.name === 'Administrator' ||
        user.email === 'mantasha@wordscloud.in'
      );
      
      if (!isAdmin) {
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

      // Helper function to convert enumeration values to human-readable format
      const convertBacklinkValidity = (value) => {
        const validityMap = {
          'one_year': '1 Year',
          'three_years': '3 Years', 
          'five_years': '5 Years',
          'lifetime': 'Lifetime'
        };
        return validityMap[value] || 'Lifetime';
      };

      // Map publisher-website fields to marketplace fields
      const marketplaceData = {
        url: submission.url,
        
        // ADVERTISER PRICING (what publisher entered - this is what advertisers pay)
        price: submission.generalGuestPostPrice || 0,
        link_insertion_price: submission.generalLinkInsertionPrice || 0,
        adv_casino_pricing: submission.casinoGuestPostPrice || 0,
        adv_li_casino_pricing: submission.casinoLinkInsertionPrice || 0,
        adv_crypto_pricing: submission.cryptoGuestPostPrice || 0,
        adv_li_crypto_pricing: submission.cryptoLinkInsertionPrice || 0,
        adv_cbd_pricing: submission.cbdGuestPostPrice || 0,
        adv_li_cbd_pricing: submission.cbdLinkInsertionPrice || 0,
        adv_dating_pricing: submission.datingGuestPostPrice || 0,
        adv_li_dating_pricing: submission.datingLinkInsertionPrice || 0,

        // PUBLISHER EARNINGS (advertiser price - 20% = 80% of what they entered)
        publisher_price: Math.floor(Math.max(
          (submission.generalGuestPostPrice || 0) * 0.8,
          (submission.generalLinkInsertionPrice || 0) * 0.8
        )) || 1, // Ensure it's at least 1 since it's required
        publisher_link_insertion_price: Math.floor((submission.generalLinkInsertionPrice || 0) * 0.8),
        
        // Publisher earnings for sensitive categories
        publisher_casino_pricing: Math.floor(Math.max(
          (submission.casinoGuestPostPrice || 0) * 0.8,
          (submission.casinoLinkInsertionPrice || 0) * 0.8
        )),
        publisher_crypto_pricing: Math.floor(Math.max(
          (submission.cryptoGuestPostPrice || 0) * 0.8,
          (submission.cryptoLinkInsertionPrice || 0) * 0.8
        )),
        publisher_cbd_pricing: Math.floor(Math.max(
          (submission.cbdGuestPostPrice || 0) * 0.8,
          (submission.cbdLinkInsertionPrice || 0) * 0.8
        )),
        publisher_dating_pricing: Math.floor(Math.max(
          (submission.datingGuestPostPrice || 0) * 0.8,
          (submission.datingLinkInsertionPrice || 0) * 0.8
        )),
        
        // Publisher earnings for specific Link Insertion sensitive categories
        publisher_li_casino_pricing: Math.floor((submission.casinoLinkInsertionPrice || 0) * 0.8),
        publisher_li_crypto_pricing: Math.floor((submission.cryptoLinkInsertionPrice || 0) * 0.8),
        publisher_li_cbd_pricing: Math.floor((submission.cbdLinkInsertionPrice || 0) * 0.8),
        publisher_li_dating_pricing: Math.floor((submission.datingLinkInsertionPrice || 0) * 0.8),

        min_word_count: submission.minWordCount,
        backlink_type: submission.backlinkType,
        category: Array.isArray(submission.category) ? submission.category : [submission.category].filter(Boolean), // Handle both array and string
        guidelines: submission.guidelines,
        backlink_validity: convertBacklinkValidity(submission.backlinkValidity),
        publisher_name: submission.publisherName || submission.publisherEmail.split('@')[0],
        publisher_email: submission.publisherEmail,
        
        // Map new content options
        sponsored: submission.sponsored,
        ugc: submission.ugc,
        digital_pr: submission.isPRSite,
        publisher_writing_price: submission.copywritingPrice || 0,

        // Map delivery and samples
        tat: Math.ceil(submission.expectedTATHours / 24), // Convert hours to days
        placement_speed: submission.expectedTATHours <= 72 ? 'Fast' : 'Normal',
        sample_links: JSON.stringify(submission.samplePosts || []), // Convert array to JSON string

        // Existing fields
        countries: submission.countries,
        language: Array.isArray(submission.language) ? submission.language : [submission.language].filter(Boolean), // Handle both array and string
        website_status: 'active',
        gsc_verified: submission.gscVerified || false,
        gsc_verified_at: submission.gscVerifiedAt,
        gsc_permission_level: submission.gscPermissionLevel
      };

      // Clean up undefined values before sending to Strapi
      Object.keys(marketplaceData).forEach(key => {
        if (marketplaceData[key] === undefined) {
          delete marketplaceData[key];
        }
      });

      if (existingListing && existingListing.length > 0) {
        console.log('Updating existing marketplace listing:', existingListing[0].id);
        console.log('New pricing data:', {
          price: marketplaceData.price,
          link_insertion_price: marketplaceData.link_insertion_price,
          adv_casino_pricing: marketplaceData.adv_casino_pricing,
          adv_crypto_pricing: marketplaceData.adv_crypto_pricing,
          publisher_price: marketplaceData.publisher_price,
          publisher_casino_pricing: marketplaceData.publisher_casino_pricing
        });
        
        // Update existing listing
        const updated = await strapi.entityService.update('api::marketplace.marketplace', existingListing[0].id, {
          data: marketplaceData
        });
        
        console.log('Marketplace updated successfully with new pricing');
        
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
  },

  // Delete publisher website and associated marketplace listing
  async delete(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to delete websites.');
      }

      // First find the website to check ownership
      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Check if the website belongs to the current user
      if (website.publisherEmail !== user.email) {
        return ctx.forbidden('You can only delete your own website submissions.');
      }

      console.log(`Deleting website ID: ${id} for user: ${user.email}`);

      // If website has a marketplace listing, delete it first
      if (website.marketplaceId) {
        try {
          console.log(`Deleting marketplace listing ID: ${website.marketplaceId}`);
          await strapi.entityService.delete('api::marketplace.marketplace', website.marketplaceId);
          console.log('Marketplace listing deleted successfully');
        } catch (marketplaceError) {
          console.error('Error deleting marketplace listing:', marketplaceError);
          // Continue with deletion even if marketplace deletion fails
          // This prevents orphaned publisher websites
        }
      }

      // Delete the publisher website
      await strapi.entityService.delete('api::publisher-website.publisher-website', id);
      console.log('Publisher website deleted successfully');

      return {
        data: {
          id: website.id,
          url: website.url,
          deleted: true,
          deletedAt: new Date().toISOString()
        },
        message: 'Website and associated marketplace listing deleted successfully'
      };

    } catch (error) {
      console.error('Error deleting publisher website:', error);
      return ctx.internalServerError('Failed to delete website');
    }
  }
}));
