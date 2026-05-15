'use strict';

/**
 * publisher-website controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { getPublisherCommissionRate } = require('../../../constants/commission');

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

      // Handle reseller code if provided
      let resellerCodeData = null;
      if (data.resellerCode) {
        try {
          // Validate and use the reseller code
          const codeValidation = await strapi.service('api::reseller-code.reseller-code').validateCode(data.resellerCode);

          if (!codeValidation.valid) {
            return ctx.badRequest(`Invalid reseller code: ${codeValidation.reason}`);
          }

          // Use the code (increment counter)
          await strapi.service('api::reseller-code.reseller-code').useCode(data.resellerCode, user.id);
          resellerCodeData = codeValidation.codeData;

        } catch (error) {
          console.error('Error processing reseller code:', error);
          return ctx.badRequest('Failed to validate reseller code');
        }
      }

      // Normalize URL to lowercase to prevent case-sensitive duplicates
      data.url = data.url ? data.url.toLowerCase() : data.url;

      // Check if this URL already exists for this publisher using ID relation
      const existingSubmission = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: {
          url: data.url,
          currentPublisherId: user.id
        }
      });

      // Prepare submission data
      const submissionData = {
        ...data,
        publisherEmail: user.email,
        publisherName: user.username || user.email,
        publishedAt: new Date()
      };

      // Add reseller code data if provided
      if (resellerCodeData) {
        submissionData.addedByReseller = true;
        submissionData.resellerCode = data.resellerCode;
        submissionData.originalPublisherId = user.id;
        submissionData.currentPublisherId = user.id;
        // Reseller code bypasses verification
        submissionData.submissionStatus = 'pending_final_submission';
        submissionData.stepCompleted = 2;
        submissionData.verificationMethod = 'reseller-code';
        submissionData.gscVerified = false; // Not GSC verified, but reseller verified
      } else {
        submissionData.addedByReseller = false;
        submissionData.currentPublisherId = user.id;
        submissionData.submissionStatus = data.gscVerified ? 'verified_pending_review' : 'pending_verification';
      }

      let result;
      if (existingSubmission && existingSubmission.length > 0) {
        // Update existing submission
        result = await strapi.entityService.update('api::publisher-website.publisher-website', existingSubmission[0].id, {
          data: submissionData
        });
      } else {
        // Create new submission
        result = await strapi.entityService.create('api::publisher-website.publisher-website', {
          data: submissionData
        });
      }

      // Send website added email notification
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendWebsiteStatusEmail({
          publisherEmail: user.email,
          publisherName: user.username || user.email,
          websiteName: data.url,
          websiteUrl: data.url,
          actionType: 'Submitted for Moderation',
          is_added: true
        });
      } catch (emailError) {
        console.error('[EMAIL] Failed to send website added email:', emailError.message);
      }

      return { data: result };
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

      // Extract pagination and filter parameters
      // Strapi parses nested query params like pagination[page] into ctx.query.pagination.page
      const pagination = ctx.query.pagination || {};
      const page = parseInt(pagination.page) || 1;
      const pageSize = Math.min(parseInt(pagination.pageSize) || 20, 100); // Max 100 per page
      const offset = (page - 1) * pageSize;

      // Build filters using immutable user ID relation (PRIMARY) or email (FALLBACK)
      const filters = {
        $or: [
          { currentPublisherId: user.id },
          { publisherEmail: user.email }
        ]
      };

      // Add search filter if provided
      // Strapi parses filters[url][$containsi] into ctx.query.filters.url.$containsi
      if (ctx.query.filters?.url?.$containsi) {
        filters.url = { $containsi: ctx.query.filters.url.$containsi };
      }

      // Add status filter if provided
      // Strapi parses filters[submissionStatus][$eq] into ctx.query.filters.submissionStatus.$eq
      if (ctx.query.filters?.submissionStatus?.$eq) {
        filters.submissionStatus = ctx.query.filters.submissionStatus.$eq;
      }

      // Get sort parameter
      const sortParam = ctx.query.sort || 'updatedAt:desc';
      const [sortField, sortDirection] = sortParam.split(':');
      const sort = { [sortField]: sortDirection === 'asc' ? 'asc' : 'desc' };

      // Get total count for pagination (before fetching data)
      const total = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: filters
      });

      // Get approved count across ALL pages (using base user ownership filters, ignoring search/status filters)
      const baseOwnershipFilters = {
        $or: [
          { currentPublisherId: user.id },
          { publisherEmail: user.email }
        ],
        submissionStatus: 'approved'
      };
      const approvedCount = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: baseOwnershipFilters
      });

      // Fetch paginated submissions using database query API for better performance
      const submissions = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: filters,
        orderBy: sort,
        limit: pageSize,
        offset: offset,
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      // Optimize order count queries - batch fetch all marketplaces at once
      const websiteUrls = submissions.map(w => w.url);
      const marketplaces = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: {
          url: { $in: websiteUrls },
          $or: [
            { publisher: user.id },
            { publisher_email: user.email }
          ]
        },
        fields: ['id', 'url']
      });

      // Create a map of URL to marketplace ID for quick lookup
      const urlToMarketplaceMap = new Map();
      marketplaces.forEach(m => {
        urlToMarketplaceMap.set(m.url, m.id);
      });

      // Batch fetch all orders for all marketplaces at once
      const marketplaceIds = Array.from(urlToMarketplaceMap.values());
      let allOrders = [];
      if (marketplaceIds.length > 0) {
        allOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            website: { $in: marketplaceIds },
            orderStatus: { $in: ['completed', 'delivered', 'accepted', 'in_progress'] }
          },
          fields: ['id', 'website', 'createdAt']
        });
      }

      // Group orders by marketplace ID
      const ordersByMarketplace = new Map();
      allOrders.forEach(order => {
        const marketplaceId = order.website;
        if (!ordersByMarketplace.has(marketplaceId)) {
          ordersByMarketplace.set(marketplaceId, []);
        }
        ordersByMarketplace.get(marketplaceId).push(order);
      });

      // Process submissions with order counts
      const submissionsWithOrders = submissions.map((website) => {
        try {
          const marketplaceId = urlToMarketplaceMap.get(website.url);

          if (!marketplaceId) {
            return {
              ...website,
              orders: 0,
              resellerOrders: 0,
              originalPublisherOrders: 0
            };
          }

          const orders = ordersByMarketplace.get(marketplaceId) || [];
          const totalOrders = orders.length;

          // Get reseller vs original publisher order split
          let resellerOrders = 0;
          let originalPublisherOrders = 0;

          if (website.ownershipTransferredAt) {
            const transferDate = new Date(website.ownershipTransferredAt);

            orders.forEach(order => {
              const orderDate = new Date(order.createdAt);
              if (orderDate < transferDate) {
                resellerOrders++;
              } else {
                originalPublisherOrders++;
              }
            });
          }

          return {
            ...website,
            orders: totalOrders,
            resellerOrders: website.ownershipTransferredAt ? resellerOrders : 0,
            originalPublisherOrders: website.ownershipTransferredAt ? originalPublisherOrders : 0,
            marketplaceId: marketplaceId
          };
        } catch (error) {
          console.error(`Error processing orders for website ${website.url}:`, error);
          // Return website with zero orders if there's an error
          return {
            ...website,
            orders: 0,
            resellerOrders: 0,
            originalPublisherOrders: 0
          };
        }
      });

      // Calculate pagination metadata
      const pageCount = Math.ceil(total / pageSize);

      return {
        data: submissionsWithOrders,
        meta: {
          pagination: {
            page: page,
            pageSize: pageSize,
            pageCount: pageCount,
            total: total
          },
          approvedCount: approvedCount
        }
      };
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

      // Find the website with publisher relation populated
      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Check ownership: prefer userId, fallback to email for legacy records
      const isOwner = (website.currentPublisherId && website.currentPublisherId.id === user.id) ||
        (!website.currentPublisherId && website.publisherEmail === user.email);

      if (!isOwner) {
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
      console.log("dataaa", data)
      if (!user) {
        return ctx.unauthorized('You must be logged in to update a website.');
      }

      // Check if this submission belongs to the user (using ID relation if possible, fallback to email for legacy)
      const existing = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['updateRequests', 'currentPublisherId']
      });

      // Verification logic: prefer ID check, fallback to email
      const isOwner = (existing.currentPublisherId && existing.currentPublisherId.id === user.id) ||
        (existing.publisherEmail === user.email);

      if (!existing || !isOwner) {
        return ctx.forbidden('You can only update your own website submissions.');
      }

      // Handle reseller code if provided in update data
      if (data.resellerCode) {

        // Only process if this is a NEW code (not already used for this website)
        // This prevents double-counting if user updates the website multiple times
        if (!existing.resellerCode || existing.resellerCode !== data.resellerCode) {

          try {
            // Validate the code

            const codeValidation = await strapi.service('api::reseller-code.reseller-code').validateCode(data.resellerCode);

            if (!codeValidation.valid) {
              return ctx.badRequest(`Invalid reseller code: ${codeValidation.reason}`);
            }

            // Use the code (increment counter)

            const useResult = await strapi.service('api::reseller-code.reseller-code').useCode(data.resellerCode, user.id);

          } catch (error) {
            return ctx.badRequest('Failed to validate reseller code');
          }
        }
      }

      // Filter out relation fields that shouldn't be updated directly
      const {
        originalPublisherId,
        currentPublisherId,
        claimedBy,
        originalWebsiteId,
        ...updateData
      } = data;

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          ...updateData,
          // Don't override submissionStatus if it's explicitly provided
          submissionStatus: data.submissionStatus || existing.submissionStatus,
        }
      });

      console.log("updated", updated)
      console.log("existing", existing)

      // If this is an approved website being updated, queue a marketplace update request instead of updating live data
      if (existing.submissionStatus === 'approved' && existing.marketplaceId) {
        console.log('Creating pending marketplace update request for approved website...');
        try {
          const marketplaceListing = await strapi.entityService.findOne('api::marketplace.marketplace', existing.marketplaceId);

          if (marketplaceListing) {
            const fieldMap = {
              generalGuestPostPrice: 'price',
              generalLinkInsertionPrice: 'link_insertion_price',
              casinoGuestPostPrice: 'adv_casino_pricing',
              casinoLinkInsertionPrice: 'adv_li_casino_pricing',
              cryptoGuestPostPrice: 'adv_crypto_pricing',
              cryptoLinkInsertionPrice: 'adv_li_crypto_pricing',
              cbdGuestPostPrice: 'adv_cbd_pricing',
              cbdLinkInsertionPrice: 'adv_li_cbd_pricing',
              datingGuestPostPrice: 'adv_dating_pricing',
              datingLinkInsertionPrice: 'adv_li_dating_pricing',
              expectedTATHours: 'tat',
              minWordCount: 'min_word_count',
              backlinkType: 'backlink_type',
              backlinkValidity: 'backlink_validity',
              countries: 'countries',
              language: 'language',
              category: 'category',
              guidelines: 'guidelines',
              description: 'description',
              publicationLocation: 'publication_location',
              sponsored: 'sponsored',
              ugc: 'ugc',
              copywritingPrice: 'publisher_writing_price'
            };

            const changes = {};
            const baseSnapshot = {};

            Object.entries(fieldMap).forEach(([publisherField, marketplaceField]) => {
              const publisherValue = updated[publisherField];
              const liveValue = marketplaceListing[marketplaceField];

              const normalise = (value) => {
                if (Array.isArray(value)) {
                  return JSON.stringify([...value].sort());
                }
                if (typeof value === 'object' && value !== null) {
                  return JSON.stringify(value);
                }
                return value;
              };

              if (normalise(publisherValue) !== normalise(liveValue)) {
                baseSnapshot[marketplaceField] = liveValue;
                changes[marketplaceField] = publisherField === 'expectedTATHours'
                  ? Math.ceil((publisherValue || 0) / 24)
                  : publisherValue;
              }
            });

            if (Object.prototype.hasOwnProperty.call(changes, 'tat')) {
              const tatDays = changes.tat || 0;
              baseSnapshot.placement_speed = marketplaceListing.placement_speed;
              changes.placement_speed = tatDays <= 3 ? 'Fast' : tatDays <= 7 ? 'Normal' : 'Slow';
            }

            if (Object.keys(changes).length > 0) {
              const pendingRequest = await strapi.entityService.create('api::website-update-request.website-update-request', {
                data: {
                  status: 'pending',
                  source: 'publisher',
                  marketplace: marketplaceListing.id,
                  publisherWebsite: updated.id,
                  submittedBy: user.email,
                  submittedAt: new Date(),
                  baseSnapshot,
                  changes,
                  dataVersion: marketplaceListing.dataVersion || 0
                }
              });

              // Supersede any older pending requests from the same publisher
              await strapi.db.query('api::website-update-request.website-update-request').updateMany({
                where: {
                  marketplace: marketplaceListing.id,
                  status: 'pending',
                  id: { $ne: pendingRequest.id }
                },
                data: {
                  status: 'superseded',
                  notes: 'Superseded by newer publisher update'
                }
              });
            } else {
              console.log('No tracked marketplace fields were changed by publisher update.');
            }
          }
        } catch (marketplaceError) {
          console.error('Failed to queue marketplace update request:', marketplaceError);
          // Continue without failing the publisher update
        }
      }

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

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });
      console.log('Found submission:', submission?.url || 'No submission found');

      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      // CRITICAL: Check if publisher is linked BEFORE approving
      // Get publisher ID from relation or try to look up by email
      let publisherId = submission.currentPublisherId?.id || submission.currentPublisherId;

      if (!publisherId && submission.publisherEmail) {
        // Try to find user by email
        const userByEmail = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { email: submission.publisherEmail }
        });
        if (userByEmail) {
          publisherId = userByEmail.id;
          // Update the submission with the found publisher ID
          await strapi.entityService.update('api::publisher-website.publisher-website', id, {
            data: { currentPublisherId: publisherId }
          });
          console.log(`[Approve] Linked publisher ${publisherId} from email ${submission.publisherEmail}`);
        }
      }

      if (!publisherId) {
        return ctx.badRequest(`Cannot approve website: No valid publisher account found for ${submission.url}. Publisher must register first.`);
      }

      // Update submission status to approved
      const approved = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'approved',
          reviewedAt: new Date(),
          reviewedBy: user?.email || 'system',
          reviewNotes: ctx.request.body.reviewNotes || 'Approved by admin',
          approvedAt: new Date()
        }
      });

      // Create marketplace entry
      // Use the original 'submission' which has currentPublisherId populated, not 'approved'
      try {
        const marketplaceListing = await this.createMarketplaceListing(submission);
        console.log(`Website ${submission.url} approved and marketplace listing created (ID: ${marketplaceListing?.id})`);

        // Send approval email notification
        try {
          const emailService = strapi.service('api::global.email-operations');
          await emailService.sendWebsiteStatusEmail({
            publisherEmail: submission.publisherEmail,
            publisherName: submission.publisherName || submission.publisherEmail,
            websiteName: submission.url,
            websiteUrl: submission.url,
            actionType: 'Approved & Live',
            notes: ctx.request.body.reviewNotes || ''
          });
        } catch (emailError) {
          console.error('[EMAIL] Failed to send website approval email:', emailError.message);
        }

        return { data: approved, message: 'Website approved and added to marketplace' };
      } catch (marketplaceError) {
        console.error('Failed to create marketplace listing:', marketplaceError);

        // Revert approval status since marketplace creation failed
        await strapi.entityService.update('api::publisher-website.publisher-website', id, {
          data: {
            submissionStatus: 'verified_pending_review',  // Revert to pending review
            reviewNotes: `Marketplace creation failed: ${marketplaceError.message}`
          }
        });

        return ctx.badRequest(`Website approval failed: ${marketplaceError.message}`);
      }
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

      // Send rejection email notification
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendWebsiteStatusEmail({
          publisherEmail: submission.publisherEmail,
          publisherName: submission.publisherName || submission.publisherEmail,
          websiteName: submission.url,
          websiteUrl: submission.url,
          actionType: 'Rejected',
          notes: rejectionReason
        });
      } catch (emailError) {
        console.error('[EMAIL] Failed to send website rejection email:', emailError.message);
      }

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
      const existingListing = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: {
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

      // Platform commission share — env-configurable via PUBLISHER_COMMISSION_RATE
      // (default 1.0 = publisher gets 100%). The publisher_* payout fields
      // below all multiply the advertiser price by this rate.
      const COMMISSION_RATE = getPublisherCommissionRate();

      // Extract publisher info BEFORE creating the marketplaceData object
      // Handle both populated object and raw ID for currentPublisherId
      const publisherUser = submission.currentPublisherId;
      let publisherId = typeof publisherUser === 'object' && publisherUser !== null
        ? publisherUser.id
        : publisherUser;

      // CRITICAL: Ensure we have a valid publisher ID
      // If no publisherId from currentPublisherId, try to look up by email
      if (!publisherId && submission.publisherEmail) {
        const userByEmail = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { email: submission.publisherEmail }
        });
        if (userByEmail) {
          publisherId = userByEmail.id;
          console.log(`[createMarketplaceListing] Linked publisher ${publisherId} from email ${submission.publisherEmail}`);
        }
      }

      // If still no publisher ID, reject the listing
      if (!publisherId) {
        throw new Error(`Cannot create marketplace listing: No valid publisher account found for ${submission.url}. Publisher email: ${submission.publisherEmail || 'not provided'}`);
      }

      const publisherEmailValue = (typeof publisherUser === 'object' && publisherUser !== null)
        ? publisherUser.email
        : submission.publisherEmail;
      const publisherNameValue = (typeof publisherUser === 'object' && publisherUser !== null)
        ? publisherUser.username
        : (submission.publisherName || submission.publisherEmail?.split('@')[0]);

      // Map publisher-website fields to marketplace fields
      // IMPORTANT: Price should be null if not provided, never default to 0
      const marketplaceData = {
        url: submission.url,

        // ADVERTISER PRICING (what publisher entered - this is what advertisers pay)
        // If price is not provided (null/undefined/0), keep as null
        price: submission.generalGuestPostPrice > 0 ? submission.generalGuestPostPrice : null,
        link_insertion_price: submission.generalLinkInsertionPrice > 0 ? submission.generalLinkInsertionPrice : null,
        adv_casino_pricing: submission.casinoGuestPostPrice > 0 ? submission.casinoGuestPostPrice : null,
        adv_li_casino_pricing: submission.casinoLinkInsertionPrice > 0 ? submission.casinoLinkInsertionPrice : null,
        adv_crypto_pricing: submission.cryptoGuestPostPrice > 0 ? submission.cryptoGuestPostPrice : null,
        adv_li_crypto_pricing: submission.cryptoLinkInsertionPrice > 0 ? submission.cryptoLinkInsertionPrice : null,
        adv_cbd_pricing: submission.cbdGuestPostPrice > 0 ? submission.cbdGuestPostPrice : null,
        adv_li_cbd_pricing: submission.cbdLinkInsertionPrice > 0 ? submission.cbdLinkInsertionPrice : null,
        adv_dating_pricing: submission.datingGuestPostPrice > 0 ? submission.datingGuestPostPrice : null,
        adv_li_dating_pricing: submission.datingLinkInsertionPrice > 0 ? submission.datingLinkInsertionPrice : null,

        // PUBLISHER EARNINGS = advertiser price × PUBLISHER_COMMISSION_RATE
        // Only calculate if price is provided, otherwise null
        publisher_price: (submission.generalGuestPostPrice > 0 || submission.generalLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.generalGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.generalLinkInsertionPrice || 0) * COMMISSION_RATE
          )) || 1
          : null,
        publisher_link_insertion_price: submission.generalLinkInsertionPrice > 0
          ? Math.floor(submission.generalLinkInsertionPrice * COMMISSION_RATE)
          : null,

        // Publisher earnings for sensitive categories
        publisher_casino_pricing: (submission.casinoGuestPostPrice > 0 || submission.casinoLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.casinoGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.casinoLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,
        publisher_crypto_pricing: (submission.cryptoGuestPostPrice > 0 || submission.cryptoLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.cryptoGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.cryptoLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,
        publisher_cbd_pricing: (submission.cbdGuestPostPrice > 0 || submission.cbdLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.cbdGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.cbdLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,
        publisher_dating_pricing: (submission.datingGuestPostPrice > 0 || submission.datingLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.datingGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.datingLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,

        // Publisher earnings for specific Link Insertion sensitive categories
        publisher_li_casino_pricing: submission.casinoLinkInsertionPrice > 0
          ? Math.floor(submission.casinoLinkInsertionPrice * COMMISSION_RATE)
          : null,
        publisher_li_crypto_pricing: submission.cryptoLinkInsertionPrice > 0
          ? Math.floor(submission.cryptoLinkInsertionPrice * COMMISSION_RATE)
          : null,
        publisher_li_cbd_pricing: submission.cbdLinkInsertionPrice > 0
          ? Math.floor(submission.cbdLinkInsertionPrice * COMMISSION_RATE)
          : null,
        publisher_li_dating_pricing: submission.datingLinkInsertionPrice > 0
          ? Math.floor(submission.datingLinkInsertionPrice * COMMISSION_RATE)
          : null,

        min_word_count: submission.minWordCount,
        backlink_type: submission.backlinkType,
        category: Array.isArray(submission.category) ? submission.category : [submission.category].filter(Boolean), // Handle both array and string
        guidelines: submission.guidelines,
        description: submission.description, // Website description
        publication_location: submission.publicationLocation, // Where article will be published
        backlink_validity: convertBacklinkValidity(submission.backlinkValidity),
        // Use the pre-extracted publisher values
        publisher_name: publisherNameValue,
        publisher_email: publisherEmailValue,
        // Map the immutable User ID relation
        publisher: publisherId, // Always required - validation above ensures this exists

        // Map new content options
        sponsored: submission.sponsored,
        ugc: submission.ugc,
        digital_pr: submission.isPRSite,
        publisher_writing_price: submission.copywritingPrice > 0 ? submission.copywritingPrice : null,

        // Map delivery and samples
        tat: Math.ceil(submission.expectedTATHours / 24), // Convert hours to days
        placement_speed: submission.expectedTATHours <= 72 ? 'Fast' : 'Normal',
        sample_links: JSON.stringify(submission.samplePosts || []), // Convert array to JSON string

        // Existing fields
        countries: submission.countries,
        language: Array.isArray(submission.language) ? submission.language : [submission.language].filter(Boolean), // Handle both array and string
        website_status: 'active',
        status: 'active', // Default status for new marketplace listings
        publishedAt: new Date(), // Ensure published when created
        approvalStatus: 'approved', // Ensure approved when created
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

        // Ensure publishedAt and approvalStatus are set when updating
        marketplaceData.publishedAt = existingListing[0].publishedAt || new Date();
        marketplaceData.approvalStatus = existingListing[0].approvalStatus || 'approved';

        // Update existing listing using database query API for reliability
        const updated = await strapi.db.query('api::marketplace.marketplace').update({
          where: { id: existingListing[0].id },
          data: marketplaceData
        });

        console.log('Marketplace updated successfully with new pricing');
        console.log('Updated marketplace data:', {
          id: updated.id,
          url: updated.url,
          price: updated.price,
          link_insertion_price: updated.link_insertion_price,
          publishedAt: updated.publishedAt,
          approvalStatus: updated.approvalStatus
        });

        // Verify the update was applied
        const verified = await strapi.db.query('api::marketplace.marketplace').findOne({
          where: { id: existingListing[0].id }
        });

        if (verified) {
          console.log('Verification - Marketplace after update:', {
            id: verified.id,
            price: verified.price,
            link_insertion_price: verified.link_insertion_price,
            adv_casino_pricing: verified.adv_casino_pricing,
            adv_crypto_pricing: verified.adv_crypto_pricing,
            adv_cbd_pricing: verified.adv_cbd_pricing
          });

          if (marketplaceData.price !== undefined && verified.price !== marketplaceData.price) {
            console.warn('⚠️ PRICE MISMATCH after update!', {
              expected: marketplaceData.price,
              actual: verified.price,
              marketplaceId: verified.id
            });
          }
        }

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
      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Check ownership: prefer userId, fallback to email for legacy records
      const isOwner = (website.currentPublisherId && website.currentPublisherId.id === user.id) ||
        (!website.currentPublisherId && website.publisherEmail === user.email);

      if (!isOwner) {
        return ctx.forbidden('You can only delete your own website submissions.');
      }

      console.log(`Deleting website ID: ${id} for user ID: ${user.id}`);

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
  },

  // Pause/Resume listing
  async pauseListing(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to manage your listings.');
      }

      // Check if this submission belongs to the user and is approved
      const existing = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });

      // Check ownership: prefer userId, fallback to email for legacy records
      const isOwner = existing && (
        (existing.currentPublisherId && existing.currentPublisherId.id === user.id) ||
        (!existing.currentPublisherId && existing.publisherEmail === user.email)
      );

      if (!existing || !isOwner) {
        return ctx.forbidden('You can only manage your own website listings.');
      }

      if (existing.submissionStatus !== 'approved') {
        return ctx.badRequest('Only approved websites can be paused.');
      }

      // Update to paused status
      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'listing_paused',
          pausedAt: new Date()
        }
      });

      // Also update marketplace listing if it exists
      if (existing.marketplaceId) {
        try {
          await strapi.entityService.update('api::marketplace.marketplace', existing.marketplaceId, {
            data: {
              status: 'paused'
            }
          });
          console.log('✅ Marketplace listing paused successfully');
        } catch (marketplaceError) {
          console.error('⚠️ Failed to pause marketplace listing:', marketplaceError);
          // Don't fail the operation if marketplace update fails
        }
      }

      return {
        data: updated,
        message: 'Listing paused successfully. You will not receive new guest post orders.'
      };
    } catch (error) {
      console.error('Error pausing listing:', error);
      return ctx.internalServerError('Failed to pause listing');
    }
  },

  async resumeListing(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to manage your listings.');
      }

      // Check if this submission belongs to the user and is paused
      const existing = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });

      // Check ownership: prefer userId, fallback to email for legacy records
      const isOwner = existing && (
        (existing.currentPublisherId && existing.currentPublisherId.id === user.id) ||
        (!existing.currentPublisherId && existing.publisherEmail === user.email)
      );

      if (!existing || !isOwner) {
        return ctx.forbidden('You can only manage your own website listings.');
      }

      if (existing.submissionStatus !== 'listing_paused') {
        return ctx.badRequest('Only paused listings can be resumed.');
      }

      // Update to approved status (resume)
      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'approved',
          resumedAt: new Date()
        }
      });

      // Also update marketplace listing if it exists
      if (existing.marketplaceId) {
        try {
          await strapi.entityService.update('api::marketplace.marketplace', existing.marketplaceId, {
            data: {
              status: 'active'
            }
          });
          console.log('✅ Marketplace listing resumed successfully');
        } catch (marketplaceError) {
          console.error('⚠️ Failed to resume marketplace listing:', marketplaceError);
          // Don't fail the operation if marketplace update fails
        }
      }

      return {
        data: updated,
        message: 'Listing resumed successfully. You can now receive new guest post orders.'
      };
    } catch (error) {
      console.error('Error resuming listing:', error);
      return ctx.internalServerError('Failed to resume listing');
    }
  },

  /**
   * Handle ownership claim for existing website
   * POST /api/publisher-websites/claim/:id
   */
  async claimOwnership(ctx) {
    try {
      const { id } = ctx.params;
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to claim ownership.');
      }

      // Find the existing website
      const existingWebsite = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      if (!existingWebsite) {
        return ctx.notFound('Website not found');
      }

      // Check if user is already the owner (by userId or email for legacy)
      const isAlreadyOwner = (existingWebsite.currentPublisherId && existingWebsite.currentPublisherId.id === user.id) ||
        (!existingWebsite.currentPublisherId && existingWebsite.publisherEmail === user.email);

      if (isAlreadyOwner) {
        return ctx.badRequest('You already own this website');
      }

      // Check if it was added by reseller (required for claiming)
      if (!existingWebsite.addedByReseller) {
        return ctx.badRequest('This website cannot be claimed as it was not added by a reseller');
      }

      console.log('🏴 Processing ownership claim for website:', existingWebsite.url);
      console.log('🏴 Original owner:', existingWebsite.publisherEmail);
      console.log('🏴 New claiming owner:', user.email);

      // STEP 1: Create a NEW website entry for the claiming user
      // Now we can use the same URL since unique constraint is removed
      const newOwnerWebsiteData = {
        ...data,
        url: existingWebsite.url, // Same URL is now allowed
        publisherEmail: user.email,
        publisherName: user.username || user.email.split('@')[0],

        // Reference to original website
        originalWebsiteId: existingWebsite.id,
        claimedFrom: existingWebsite.publisherEmail,
        claimedAt: new Date().toISOString(),
        ownershipTransferReason: 'claimed_by_owner',

        // Set publisher relations correctly for new owner
        originalPublisherId: existingWebsite.currentPublisherId || null,
        currentPublisherId: user.id,

        // Verification details - must be GSC for claims
        verificationMethod: 'google-search-console',
        gscVerified: true,
        gscVerifiedAt: new Date().toISOString(),

        // Status - submit for admin review (NOT approved yet)
        submissionStatus: 'approval_pending',
        stepCompleted: 4,
        submittedForReviewAt: new Date().toISOString()
      };

      // Create the new website entry for the claiming user
      const newOwnerWebsite = await strapi.entityService.create('api::publisher-website.publisher-website', {
        data: newOwnerWebsiteData
      });

      console.log('✅ New website entry created for claiming user:', newOwnerWebsite.id);

      // STEP 2: Update the ORIGINAL website to show "Ownership Transferred" status
      // This keeps the original publisher's data intact but marks it as transferred
      await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'ownership_claimed',
          // ownershipTransferredAt: new Date().toISOString(),
          // ownershipTransferReason: 'claimed_by_owner',
          claimedBy: user.id,
          claimedAt: new Date().toISOString(),
          newOwnerWebsiteId: newOwnerWebsite.id, // Link to new owner's entry

          // Set relations correctly - find the original publisher's user ID
          // originalPublisherId: existingWebsite.currentPublisherId || null,
          // currentPublisherId: user.id, // New owner becomes current

          // Keep ALL original data intact - just change status
          // Original publisher can still see all their historical data
        }
      });

      console.log('✅ Original website marked as ownership transferred');

      // Send ownership claimed email to original publisher
      try {
        const emailService = strapi.service('api::global.email-operations');
        if (existingWebsite.publisherEmail) {
          await emailService.sendWebsiteStatusEmail({
            publisherEmail: existingWebsite.publisherEmail,
            publisherName: existingWebsite.publisherName || existingWebsite.publisherEmail,
            websiteName: existingWebsite.url,
            websiteUrl: existingWebsite.url,
            actionType: 'Ownership Claimed',
            notes: `Ownership has been claimed by another user. Your listing will be updated accordingly.`
          });
        }
      } catch (emailError) {
        console.error('[EMAIL] Failed to send ownership claimed email:', emailError.message);
      }

      // Note: Marketplace delisting will be handled automatically by the lifecycle hook
      // when the new owner's website gets approved

      return ctx.send({
        success: true,
        message: 'Ownership claimed successfully! Your website has been submitted for review.',
        data: {
          newWebsiteId: newOwnerWebsite.id,
          originalWebsiteId: existingWebsite.id,
          claimedWebsite: newOwnerWebsite
        }
      });

    } catch (error) {
      console.error('Error processing ownership claim:', error);
      return ctx.internalServerError('Failed to process ownership claim');
    }
  },



  /**
   * Check if a domain can be claimed (public endpoint)
   * GET /api/publisher-websites/check-claimable/:domain
   */
  async checkClaimable(ctx) {
    try {
      const { domain } = ctx.params;

      if (!domain) {
        return ctx.badRequest('Domain is required');
      }

      // Clean the domain and normalize to lowercase
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

      // Find all websites by URL
      const allWebsites = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: {
          url: cleanDomain
        },
        fields: ['id', 'url', 'publisherEmail', 'publisherName', 'addedByReseller', 'submissionStatus', 'verificationMethod', 'gscVerified']
      });

      if (!allWebsites || allWebsites.length === 0) {
        return ctx.send({
          exists: false,
          claimable: false,
          message: 'Website not found'
        });
      }

      console.log('🔍 [checkClaimable] Found websites for', cleanDomain, ':', allWebsites.map(w => ({
        id: w.id,
        status: w.submissionStatus,
        verificationMethod: w.verificationMethod,
        publisherEmail: w.publisherEmail
      })));

      // Prioritize active websites over ownership_transferred ones
      const activeWebsites = allWebsites.filter(w => w.submissionStatus !== 'ownership_transferred');
      const website = activeWebsites.length > 0 ? activeWebsites[0] : allWebsites[0];

      console.log('🎯 [checkClaimable] Selected website:', {
        id: website.id,
        status: website.submissionStatus,
        verificationMethod: website.verificationMethod,
        isActive: activeWebsites.length > 0
      });

      console.log('🔍 [checkClaimable] Website found:', {
        id: website.id,
        url: website.url,
        publisherEmail: website.publisherEmail,
        submissionStatus: website.submissionStatus,
        verificationMethod: website.verificationMethod
      });

      // Simple logic: If verification method is Google Search Console, don't allow claiming
      const isGSCVerified = website.verificationMethod === 'google-search-console';

      console.log('🔍 [checkClaimable] GSC verified:', isGSCVerified);

      return ctx.send({
        exists: true,
        claimable: !isGSCVerified, // Can only claim if NOT verified via GSC
        isGSCVerified: isGSCVerified,
        currentStatus: website.submissionStatus,
        data: {
          id: website.id,
          url: website.url,
          publisherName: website.publisherName,
          verificationMethod: website.verificationMethod
        }
      });

    } catch (error) {
      console.error('Error checking claimable domain:', error);
      return ctx.internalServerError('Error checking domain');
    }
  },

  // Delete publisher website
  async delete(ctx) {
    const { id } = ctx.params;
    const user = ctx.state.user;

    try {
      if (!user) {
        return ctx.unauthorized('You must be logged in to delete a website.');
      }

      // Fetch the website with publisher relation
      const website = await strapi.entityService.findOne(
        'api::publisher-website.publisher-website',
        id,
        {
          populate: ['currentPublisherId']
        }
      );

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Security: Verify ownership (prefer userId, fallback to email for legacy)
      const isOwner = (website.currentPublisherId && website.currentPublisherId.id === user.id) ||
        (!website.currentPublisherId && website.publisherEmail === user.email);

      if (!isOwner) {
        return ctx.forbidden('You do not have permission to delete this website');
      }

      // Business Rule: Cannot delete verified websites (Step 2+)
      if (website.gscVerified || website.addedByReseller) {
        return ctx.badRequest({
          error: 'Cannot delete verified website',
          message: 'This website has been verified and cannot be deleted. Please contact support if you need assistance.'
        });
      }

      // Business Rule: Only allow deletion if step 1
      if (website.stepCompleted > 1) {
        return ctx.badRequest({
          error: 'Cannot delete verified website',
          message: 'This website has completed verification and cannot be deleted.'
        });
      }

      // Business Rule: Only allow deletion if status is pending_verification
      if (website.submissionStatus !== 'pending_verification') {
        return ctx.badRequest({
          error: 'Invalid website status',
          message: 'Only websites in pending verification status can be deleted.'
        });
      }

      // All checks passed - proceed with deletion
      await strapi.entityService.delete(
        'api::publisher-website.publisher-website',
        id
      );

      return ctx.send({
        success: true,
        message: 'Website deleted successfully'
      });

    } catch (error) {
      strapi.log.error('Error deleting website:', error);
      return ctx.internalServerError('An error occurred while deleting the website');
    }
  }

}));
