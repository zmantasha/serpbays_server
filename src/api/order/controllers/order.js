'use strict';

/**
 * order controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Helper function to check if publisher wallet exists
async function checkPublisherWallet(userId) {
  try {
    // Check if publisher wallet exists
    const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: {
        users_permissions_user: userId,
        type: 'publisher'
      }
    });

    return publisherWallet !== null;
  } catch (error) {
    console.error('Error checking publisher wallet:', error);
    return false;
  }
}

module.exports = createCoreController('api::order.order', ({ strapi }) => {
  // Helper function to format links for storage
  const formatLinks = (links) => {
    // If links is already a JSON string, leave it as is
    if (typeof links === 'string') {
      try {
        // Check if it's valid JSON
        const parsed = JSON.parse(links);
        return links; // It's already a JSON string
      } catch (e) {
        // It's a single link, convert to JSON string array
        return JSON.stringify([links]);
      }
    }

    // If links is an array, stringify it
    if (Array.isArray(links)) {
      return JSON.stringify(links);
    }

    // If links is some other type, convert to empty array
    return JSON.stringify([]);
  };

  return {
    // Custom create method to handle order creation with content
    async create(ctx) {
      try {
        // Check if user is authenticated
        if (!ctx.state.user) {
          return ctx.unauthorized('You must be logged in to create an order');
        }

        // Get authenticated user
        const user = ctx.state.user;

        // Extract order data and content data from request body
        const {
          content,
          links,
          anchorText,
          metaDescription,
          keywords,
          url,
          title,
          instructions,
          projectName,
          projectId,
          outsourceLinks,
          // Link Insertion specific fields
          serviceType,
          existingPostUrl,
          anchorText: linkInsertionAnchorText,
          landingPageUrl,
          linkInsertionLanguage,
          linkInsertionDescription,
          ...orderData
        } = ctx.request.body.data || ctx.request.body;
        console.log("projectId", projectId)
        console.log(projectName)
        // If projectId is provided, verify it exists and belongs to the user
        if (projectId) {
          const project = await strapi.db.query('api::project.project').findOne({
            where: {
              id: projectId,
              owner: user.id
            }
          });

          if (!project) {
            return ctx.badRequest(`Project with ID ${projectId} not found or does not belong to you`);
          }

          // Check if project is archived
          if (project.archived) {
            return ctx.badRequest(`Cannot create orders in archived project "${project.ProjectName}". Please unarchive the project first or create a new project.`);
          }

          // Add project to orderData
          orderData.project = projectId;
        }
        // If projectName is provided but no projectId, create a new project
        else if (projectName) {
          const newProject = await strapi.entityService.create('api::project.project', {
            data: {
              ProjectName: projectName,
              startDate: new Date(),
              owner: user.id,
              projectUrl: orderData.website // Use the website URL as project URL
            }
          });

          // Add the new project to orderData
          orderData.project = newProject.id;
        }

        console.log("orderdata", orderData);
        console.log('Creating order with data:1', orderData);

        // Check if this is an outsourced content order
        const isOutsourced = !!instructions;

        // Validate required fields
        if (!orderData.totalAmount || !orderData.description || !orderData.website) {
          return ctx.badRequest('Missing required fields: totalAmount, description and website are required');
        }

        console.log(typeof orderData.website)

        // Variables to store marketplace data and snapshot
        let marketplace = null;
        let websiteSnapshot = null;

        // If website is passed as a string ID, convert it to the proper format
        // Use strict numeric check - parseInt('100test.com') returns 100 which would incorrectly match domains starting with numbers
        if (typeof orderData.website === 'string' && /^\d+$/.test(orderData.website)) {
          console.log(`Website appears to be a string ID: ${orderData.website}, looking up by ID`);
          // Try to find the website by ID
          const websiteId = parseInt(orderData.website);
          marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: websiteId },
            populate: ['publisher']
          });

          if (!marketplace) {
            return ctx.badRequest(`Website with ID ${websiteId} not found in marketplace`);
          }

          console.log(`Found website ID ${marketplace.id} for domain ${marketplace.url}`);
          orderData.website = marketplace.id;
        }
        // If it's a domain name (preferred approach), try to find the corresponding marketplace entry
        else if (typeof orderData.website === 'string') {
          console.log(`Looking up website by domain: ${orderData.website}`);
          marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { url: orderData.website },
            populate: ['publisher']
          });
          console.log("market", marketplace)
          if (!marketplace) {
            return ctx.badRequest(`Website with domain ${orderData.website} not found in marketplace`);
          }

          console.log(`Found website ID ${marketplace.id} for domain ${orderData.website}`);
          orderData.website = marketplace.id;
        }
        // If website is already a number, verify it exists in marketplace
        else if (typeof orderData.website === 'number') {
          console.log(`Verifying website ID: ${orderData.website}`);
          marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: orderData.website },
            populate: ['publisher']
          });

          if (!marketplace) {
            return ctx.badRequest(`Website with ID ${orderData.website} not found in marketplace`);
          }

          console.log(`Verified website ID ${orderData.website} exists`);
        }

        // CRITICAL: Prevent users from ordering their own websites
        // Check if the user is trying to order their own website
        // Check 1: Direct ID match if publisher relation exists
        if (marketplace && marketplace.publisher && marketplace.publisher.id === user.id) {
          console.log(`🚫 Self-order prevented: User ${user.id} tried to order their own website ${marketplace.url} (ID match)`);
          return ctx.badRequest('You cannot place an order on your own website. Please select a different website.');
        }
        // Check 2: Email fallback
        else if (marketplace && (
          (marketplace.publisher && marketplace.publisher.email === user.email) ||
          marketplace.publisher_email === user.email
        )) {
          console.log(`🚫 Self-order prevented: User ${user.email} tried to order their own website ${marketplace.url} (Email match)`);
          return ctx.badRequest('You cannot place an order on your own website. Please select a different website.');
        }

        // Validate existingPostUrl belongs to the same domain (Link Insertion orders)
        if (serviceType === 'link_insertion' && existingPostUrl && marketplace) {
          try {
            const urlToCheck = existingPostUrl.trim().startsWith('http://') || existingPostUrl.trim().startsWith('https://')
              ? existingPostUrl.trim()
              : `https://${existingPostUrl.trim()}`;
            const urlObj = new URL(urlToCheck);
            const urlHostname = urlObj.hostname.replace(/^www\./, '');
            const expectedDomain = marketplace.url.replace(/^www\./, '').replace(/^https?:\/\//, '');
            if (urlHostname !== expectedDomain && !urlHostname.endsWith('.' + expectedDomain)) {
              return ctx.badRequest(`Existing post URL must be from ${marketplace.url}, not ${urlHostname}`);
            }
          } catch (e) {
            return ctx.badRequest('Invalid existing post URL format');
          }
        }

        // Create marketplace snapshot to preserve historical data
        if (marketplace) {
          console.log('Creating marketplace snapshot for order');
          websiteSnapshot = {
            id: marketplace.id,
            url: marketplace.url,
            price: marketplace.price,
            link_insertion_price: marketplace.link_insertion_price,
            min_word_count: marketplace.min_word_count,
            guidelines: marketplace.guidelines,
            backlink_type: marketplace.backlink_type,
            backlink_validity: marketplace.backlink_validity,
            category: marketplace.category,
            other_category: marketplace.other_category,
            publisher_name: marketplace.publisher?.username || marketplace.publisher_name,
            publisher_email: marketplace.publisher?.email || marketplace.publisher_email,
            publisher_price: marketplace.publisher_price,
            tat: marketplace.tat,
            dofollow_link: marketplace.dofollow_link,
            fast_placement_status: marketplace.fast_placement_status,
            ahrefs_dr: marketplace.ahrefs_dr,
            ahrefs_traffic: marketplace.ahrefs_traffic,
            ahrefs_rank: marketplace.ahrefs_rank,
            moz_da: marketplace.moz_da,
            language: marketplace.language,
            countries: marketplace.countries,
            forbidden_gp_price: marketplace.forbidden_gp_price,
            forbidden_li_price: marketplace.forbidden_li_price,
            publisher_forbidden_gp_price: marketplace.publisher_forbidden_gp_price,
            publisher_forbidden_li_price: marketplace.publisher_forbidden_li_price,
            publisher_link_insertion_price: marketplace.publisher_link_insertion_price,
            semrush_authority_score: marketplace.semrush_authority_score,
            semrush_traffic: marketplace.semrush_traffic,
            spam_score: marketplace.spam_score,
            adv_crypto_pricing: marketplace.adv_crypto_pricing,
            adv_casino_pricing: marketplace.adv_casino_pricing,
            adv_cbd_pricing: marketplace.adv_cbd_pricing,
            publisher_crypto_pricing: marketplace.publisher_crypto_pricing,
            publisher_casino_pricing: marketplace.publisher_casino_pricing,
            publisher_cbd_pricing: marketplace.publisher_cbd_pricing,
            similarweb_traffic: marketplace.similarweb_traffic,
            ahrefs_referring_domain: marketplace.ahrefs_referring_domain,
            domain_zone: marketplace.domain_zone,
            only_with_us: marketplace.only_with_us,
            blacklist_status: marketplace.blacklist_status,
            sample_post: marketplace.sample_post,
            capturedAt: new Date().toISOString()
          };

          // Add snapshot fields to order data
          orderData.websiteSnapshot = websiteSnapshot;
          orderData.websiteUrl = marketplace.url;
          orderData.websitePrice = marketplace.price;
          orderData.websiteLinkInsertionPrice = marketplace.link_insertion_price;
          orderData.websiteMinWordCount = marketplace.min_word_count;
          orderData.websiteGuidelines = marketplace.guidelines;
          orderData.websiteBacklinkType = marketplace.backlink_type;
          orderData.websiteBacklinkValidity = marketplace.backlink_validity;
          orderData.websiteCategory = marketplace.category;
          orderData.websitePublisherName = marketplace.publisher?.username || marketplace.publisher_name;
          orderData.websitePublisherEmail = marketplace.publisher?.email || marketplace.publisher_email;
          orderData.websitePublisherPrice = marketplace.publisher_price;
          orderData.websiteTat = marketplace.tat * 24; // Convert days to hours for frontend calculation
          orderData.websiteDofollowLink = marketplace.dofollow_link;
          orderData.websiteFastPlacement = marketplace.fast_placement_status;
          orderData.websiteAhrefsDr = marketplace.ahrefs_dr;
          orderData.websiteAhrefsTraffic = marketplace.ahrefs_traffic;
          orderData.websiteMozDa = marketplace.moz_da;
          orderData.websiteLanguage = marketplace.language;
          orderData.websiteCountries = marketplace.countries;

          console.log('Marketplace snapshot created and added to order data');
        }

        // Remove links from orderData if present to prevent conflicts
        if (orderData.links) {
          delete orderData.links;
        }

        // Check for duplicate recent orders to prevent duplicates
        const recentOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            website: orderData.website,
            advertiser: user.id,
            // Only match orders with the exact same description, which indicates a duplicate
            description: orderData.description,
            // Check orders created in the last 5 minutes
            createdAt: {
              $gt: new Date(Date.now() - 1000)
            }
          },
          limit: 1
        });

        if (recentOrders && recentOrders.length > 0) {
          console.log('Potential duplicate order detected, returning existing order');
          // Return the existing order instead of creating a duplicate
          const existingOrder = await strapi.entityService.findOne('api::order.order', recentOrders[0].id, {
            populate: ['advertiser', 'publisher', 'website', 'orderContent'],
          });

          return {
            data: existingOrder,
            meta: {
              message: 'Order already exists'
            }
          };
        }

        // Create the order
        // First prepare order data with proper fields

        // Find publisher ID: prioritize direct relation, fallback to email lookup
        let publisherId = null;
        if (marketplace && marketplace.publisher && marketplace.publisher.id) {
          publisherId = marketplace.publisher.id;
        } else if (marketplace && marketplace.publisher_email) {
          const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { email: marketplace.publisher_email }
          });
          if (publisherUser) {
            publisherId = publisherUser.id;
          }
        }

        const orderToCreate = {
          ...orderData,
          advertiser: user.id,
          // Assign publisher found via ID or email lookup
          publisher: publisherId,
          orderDate: new Date(),
          isOutsourced: isOutsourced,
          instructions: instructions || null,
          // Add Link Insertion fields if this is a Link Insertion order
          serviceType: serviceType || null,
          existingPostUrl: existingPostUrl || null,
          anchorText: linkInsertionAnchorText || null,
          landingPageUrl: landingPageUrl || null,
          linkInsertionLanguage: linkInsertionLanguage || null,
          linkInsertionDescription: linkInsertionDescription || null
        };

        console.log('Creating order with data:', orderToCreate);
        const order = await strapi.service('api::order.order').create(orderToCreate, user);
        console.log('Order created:', order);

        if (!order || !order.documentId) {
          throw new Error('Failed to create order');
        }

        console.log("orders", order)

        // Get the website/marketplace info to find the publisher (reuse existing marketplace data)
        let marketplaceWithPublisher = marketplace;
        // Marketplace doesn't have a direct publisher relation, so we use the email link we just established

        // Create notification for publisher about new order
        if (publisherId) {
          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              order.id,
              publisherId,
              user.id,
              'new_order'
            );
            console.log(`New order notification created for publisher ${publisherId}`);
          } catch (notificationError) {
            console.error('Failed to create new order notification:', notificationError);
            // Don't fail the order creation if notification fails
          }
        } else {
          console.log('No publisher user found for marketplace email, skipping new order notification');
        }

        // Handle outsourced content details if this is an outsourced order
        if (isOutsourced) {
          try {
            console.log('Creating outsourced content details');
            // Create outsourced content details
            const outsourcedContentData = {
              links: outsourceLinks || links || [],
              instructions: instructions || '',
              order: order.documentId,
              publishedAt: new Date()
            };

            // Format links properly
            if (typeof outsourcedContentData.links !== 'string' && !Array.isArray(outsourcedContentData.links)) {
              outsourcedContentData.links = [];
            }
            if (Array.isArray(outsourcedContentData.links)) {
              outsourcedContentData.links = JSON.stringify(outsourcedContentData.links);
            }

            console.log('Outsourced content data:', outsourcedContentData);

            // Create the outsourced content
            const outsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
              data: outsourcedContentData
            });

            console.log('Outsourced content created:', outsourcedContent);
          } catch (error) {
            console.error('Error creating outsourced content details:', error);
            // Continue even if this fails - we don't want to roll back the order
          }
        }

        // Define default title for content
        const defaultTitle = `Order for ${orderData.description}`;

        // Only create content object for non-outsourced orders and non-Link Insertion orders
        if (!isOutsourced && serviceType !== 'link_insertion') {
          try {
            // Process order content if needed
            let contentData = {
              // Default required fields
              content: orderData.description || '',
              title: defaultTitle,
              // Use website's min word count or default to 0
              minWordCount: orderData.websiteMinWordCount || orderData.minWordCount || 0,
              // Important: establish the relationship with the order
              order: order.documentId
            };

            // If HTML content was provided
            if (content) {
              // If content is a string, treat it as content field
              if (typeof content === 'string') {
                contentData.content = content;
              }
              // If content is an object, merge its properties
              else if (typeof content === 'object') {
                contentData = {
                  ...contentData,
                  ...content,
                  // Ensure the order relation is preserved
                  order: order.documentId
                };
              }
            }

            // Explicitly add each metadata field if they were provided in the request

            // Add links if they were provided - ensure it's stored as JSON
            if (links && (Array.isArray(links) || typeof links === 'string')) {
              // Use our formatLinks helper to ensure proper JSON storage
              contentData.links = formatLinks(links);
              console.log('Adding links to order content:', contentData.links);
            } else if (ctx.request.body.links) {
              // Try to get links directly from the request body
              contentData.links = formatLinks(ctx.request.body.links);
              console.log('Adding links from request body:', contentData.links);
            }

            // Add anchorText if provided - ensure it's stored as JSON
            if (anchorText && (Array.isArray(anchorText) || typeof anchorText === 'string')) {
              // Format anchor text similar to links
              contentData.anchorText = formatLinks(anchorText);
              console.log('Adding anchor text to order content:', contentData.anchorText);
            } else if (ctx.request.body.anchorText) {
              // Try to get anchorText directly from the request body
              contentData.anchorText = formatLinks(ctx.request.body.anchorText);
              console.log('Adding anchor text from request body:', contentData.anchorText);
            }

            // Add metaDescription if provided in the request
            if (metaDescription) {
              contentData.metaDescription = metaDescription;
            }

            // Add keywords if provided in the request
            if (keywords) {
              contentData.keywords = keywords;
            }

            // Add URL if provided in the request
            if (url) {
              contentData.url = url;
            }
            // If URL isn't provided but website is, try to use website URL from snapshot
            else if (!contentData.url && orderData.website) {
              try {
                // Use URL from marketplace snapshot if available
                if (marketplace && marketplace.url) {
                  contentData.url = marketplace.url;
                } else {
                  // Fallback: fetch the website URL 
                  const websiteInfo = await strapi.db.query('api::marketplace.marketplace').findOne({
                    where: { id: orderData.website }
                  });

                  if (websiteInfo && websiteInfo.url) {
                    contentData.url = websiteInfo.url;
                  }
                }
              } catch (err) {
                console.log('Error fetching website URL:', err);
                // Continue even if this fails
              }
            }

            // Add title if provided in the request
            if (title) {
              contentData.title = title;
            }

            console.log('Creating order content with data:', contentData);

            // Create the order content
            const newOrderContent = await strapi.entityService.create('api::order-content.order-content', {
              data: contentData
            });

            console.log('Order content created:', newOrderContent);

            // Update the order to ensure the relation is bidirectional
            await strapi.entityService.update('api::order.order', order.id, {
              data: {
                orderContent: newOrderContent.id
              }
            });

          } catch (contentError) {
            console.error('Error creating order content:', contentError);
            // We don't want to fail the whole operation if just the content creation fails
          }
        }

        // Return the created order with populated relations
        const populatedOrder = await strapi.entityService.findOne('api::order.order', order.id, {
          populate: ['advertiser', 'publisher', 'website', 'orderContent'],
        });

        // Create notification for publisher (website owner) using snapshot data
        // NOTE: We already sent the internal notification above. Sending email here.
        try {
          // Use CURRENT publisher email from relation (always up-to-date), fallback to static field for legacy entries
          let publisherEmail = null;
          if (marketplace && marketplace.publisher && marketplace.publisher.email) {
            publisherEmail = marketplace.publisher.email;
          } else if (marketplace && marketplace.publisher_email) {
            publisherEmail = marketplace.publisher_email;
          }

          if (publisherEmail) {
            // Send email notification for new order
            try {
              const emailService = strapi.service('api::global.email-operations');
              await emailService.sendOrderCreationEmail(
                populatedOrder,
                publisherEmail,
                user.email
              );
              console.log(`Order creation emails sent for order ${order.id}`);
            } catch (emailError) {
              console.error('Failed to send order creation emails:', emailError);
              // Don't fail order creation if email fails
            }
          } else {
            console.log(`Website not found or missing publisher_email for website ID: ${orderData.website}`);
          }
        } catch (notificationError) {
          console.error('Failed to create new order notification:', notificationError);
          // Don't fail the order creation if notification fails
        }

        return {
          data: populatedOrder,
          meta: {
            message: 'Order created successfully with escrow hold'
          }
        };
      } catch (error) {
        // Handle common errors with appropriate responses
        if (error.message === 'Insufficient funds') {
          return ctx.badRequest('Insufficient funds in your wallet');
        }
        if (error.message === 'Advertiser wallet not found') {
          return ctx.badRequest('No advertiser wallet found for your account');
        }
        if (error.message === 'Authentication required') {
          return ctx.unauthorized('Authentication required');
        }

        // Log and return any other errors
        console.error('Error creating order:', error);
        return ctx.badRequest(error.message || 'Error creating order');
      }
    },

    // Fix links in all existing order content records
    async fixLinks(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can fix links');
        }

        let fixed = 0;
        let errors = 0;

        // Find all order-contents
        const orderContents = await strapi.db.query('api::order-content.order-content').findMany();

        for (const content of orderContents) {
          try {
            // Check if links needs to be fixed
            if (content.links !== null) {
              let updatedLinks;

              // If links is already a string but not JSON, format it
              if (typeof content.links === 'string' && !content.links.startsWith('[')) {
                updatedLinks = JSON.stringify([content.links]);
              }
              // If links is an array, stringify it
              else if (Array.isArray(content.links)) {
                updatedLinks = JSON.stringify(content.links);
              }
              // If we need to update the links
              if (updatedLinks) {
                await strapi.entityService.update('api::order-content.order-content', content.id, {
                  data: {
                    links: updatedLinks
                  }
                });
                fixed++;
                console.log(`Fixed links for content ${content.id}`);
              }
            } else if (content.links === null && ctx.query.createEmpty) {
              // Create empty links array if requested
              await strapi.entityService.update('api::order-content.order-content', content.id, {
                data: {
                  links: JSON.stringify([])
                }
              });
              fixed++;
              console.log(`Created empty links array for content ${content.id}`);
            }
          } catch (err) {
            console.error(`Error fixing links for content ${content.id}:`, err);
            errors++;
          }
        }

        return {
          data: {
            fixed,
            errors,
            message: `Fixed links for ${fixed} records, encountered ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error fixing links:', error);
        return ctx.internalServerError('An error occurred while fixing links');
      }
    },

    // Get current user's orders with pagination and search
    async getMyOrders(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Extract query parameters
        const {
          type = 'all',
          page = 1,
          pageSize = 10,
          search = '',
          status = '',
          sortBy = 'orderDate',
          sortOrder = 'desc'
        } = ctx.query;

        // Convert page and pageSize to numbers
        const currentPage = Math.max(1, parseInt(page));
        const limit = Math.min(50, Math.max(1, parseInt(pageSize))); // Max 50 per page
        const start = (currentPage - 1) * limit;

        // Build base filters for user access
        const baseFilters = {};

        if (type === 'advertiser') {
          // Include only orders where user is advertiser
          baseFilters.advertiser = user.id;
        } else if (type === 'publisher') {
          // Use ORDER's snapshot data, NOT live marketplace data
          // This ensures orders stay with the publisher who was owner at order creation time
          // 1. Direct publisher assignment (set when order was created)
          // 2. Order's snapshotted publisher email (captured at order creation)
          baseFilters.$or = [
            { publisher: user.id },
            { websitePublisherEmail: user.email }
          ];

          // Exclude orders where user is the advertiser (to prevent self-acceptance)
          baseFilters.advertiser = { $ne: user.id };

          console.log(`[Order Filter] Publisher ${user.id} - filtering by direct publisher OR order snapshot email`);
        } else if (type === 'all') {
          // Include orders where user is advertiser OR publisher
          // Use ORDER's snapshot data for publisher matching
          baseFilters.$or = [
            { advertiser: user.id },
            { publisher: user.id },
            { websitePublisherEmail: user.email }
          ];

          console.log(`[Order Filter] User ${user.id} - filtering by direct relationships and order snapshot`);
        }

        // Add search filters
        const searchFilters = {};
        if (search && search.trim()) {
          const searchTerm = search.trim();
          searchFilters.$or = [];

          // Search by order ID (exact match if it's a number)
          if (!isNaN(searchTerm)) {
            searchFilters.$or.push({ id: parseInt(searchTerm) });
          }

          // Search by description
          // searchFilters.$or.push({
          //   description: { $containsi: searchTerm }
          // });

          // Search by website URL
          searchFilters.$or.push({
            website: {
              url: { $containsi: searchTerm }
            }
          });

          // Search by project name
          searchFilters.$or.push({
            project: {
              ProjectName: { $containsi: searchTerm }
            }
          });

          // Search by order content title
          //   searchFilters.$or.push({
          //     orderContent: {
          //       title: { $containsi: searchTerm }
          //     }
          //   });
        }

        // Add status filter
        const statusFilter = {};
        if (status && status.trim()) {
          // Handle multiple statuses (comma-separated)
          const statuses = status.split(',').map(s => s.trim()).filter(s => s);
          if (statuses.length === 1) {
            statusFilter.orderStatus = statuses[0];
          } else if (statuses.length > 1) {
            statusFilter.orderStatus = { $in: statuses };
          }
        }

        // Combine all filters
        const combinedFilters = {
          $and: [
            baseFilters,
            ...(Object.keys(searchFilters).length ? [searchFilters] : []),
            ...(Object.keys(statusFilter).length ? [statusFilter] : [])
          ]
        };

        // Build sort object
        const sortOptions = {};
        const validSortFields = ['orderDate', 'id', 'orderStatus', 'totalAmount', 'deliveredDate', 'acceptedDate', 'updatedAt'];
        const validSortOrders = ['asc', 'desc'];

        if (validSortFields.includes(sortBy) && validSortOrders.includes(sortOrder.toLowerCase())) {
          sortOptions[sortBy] = sortOrder.toLowerCase();
        } else {
          // Default sort by most recent activity (updatedAt)
          sortOptions.updatedAt = 'desc';
        }

        console.log(`Fetching orders for user ID ${user.id}, page: ${currentPage}, limit: ${limit}`);
        console.log('Combined Filters:', JSON.stringify(combinedFilters, null, 2));
        console.log('Sort Options:', sortOptions);

        // Get total count for pagination
        const totalCount = await strapi.entityService.count('api::order.order', {
          filters: combinedFilters
        });

        // Get paginated orders
        const orders = await strapi.entityService.findMany('api::order.order', {
          filters: combinedFilters,
          populate: {
            website: true,
            advertiser: {
              fields: ['id', 'username'] // Only populate id and username, exclude email
            },
            publisher: {
              fields: ['id', 'username'] // Only populate id and username, exclude email  
            },
            orderContent: true,
            outsourcedContent: true,
            project: true,
            communications: true
          },
          sort: sortOptions,
          start,
          limit
        });

        // Calculate pagination info
        const totalPages = Math.ceil(totalCount / limit);
        const hasNextPage = currentPage < totalPages;
        const hasPrevPage = currentPage > 1;

        console.log(`Found ${orders.length} orders out of ${totalCount} total for user ID ${user.id}`);

        return {
          data: orders,
          meta: {
            pagination: {
              page: currentPage,
              pageSize: limit,
              pageCount: totalPages,
              total: totalCount,
              hasNextPage,
              hasPrevPage
            },
            search: {
              query: search,
              status: status,
              type: type
            },
            sort: {
              field: sortBy,
              order: sortOrder
            }
          }
        };
      } catch (error) {
        console.error('Error fetching user orders:', error);
        return ctx.internalServerError('An error occurred while fetching orders');
      }
    },

    // Get orders available for publishers to accept
    async getAvailableOrders(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Get publisher's websites by matching ID or fallback to email
        // For available orders, we ONLY want active websites they currently own
        const publisherWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
          where: {
            $or: [
              { publisher: user.id },
              { publisher_email: user.email }
            ],
            status: { $in: ['active', 'delisted'] } // Include delisted websites so pending orders remain visible after admin rejection
          }
        });

        console.log(`[Available Orders] User ${user.id} (${user.email}) found ${publisherWebsites.length} websites:`);
        publisherWebsites.forEach(website => {
          console.log(`  - Website ${website.id}: ${website.url} (status: ${website.status}, delisted reason: ${website.delistedReason || 'N/A'})`);
        });

        // Debug: Check what orders exist for wordscloud.in
        if (publisherWebsites.some(w => w.url === 'wordscloud.in')) {
          const wordscloudinSite = publisherWebsites.find(w => w.url === 'wordscloud.in');
          console.log(`[Debug] Checking orders for wordscloud.in (website ID: ${wordscloudinSite.id})`);

          const allOrdersForSite = await strapi.entityService.findMany('api::order.order', {
            filters: {
              website: { id: wordscloudinSite.id }
            },
            populate: ['website', 'advertiser', 'publisher']
          });

          console.log(`[Debug] Found ${allOrdersForSite.length} total orders for wordscloud.in:`);
          allOrdersForSite.forEach(order => {
            console.log(`  - Order ${order.id}: Status=${order.orderStatus}, Publisher=${order.publisher?.id || 'null'}, Date=${order.orderDate}, Advertiser=${order.advertiser?.id}`);
          });
        }

        let orders = [];

        if (!publisherWebsites || publisherWebsites.length === 0) {
          // If user has no publisher websites, they cannot see any available orders
          return {
            data: [],
            meta: {
              message: 'No websites found for this publisher'
            }
          };
        }

        // Get website IDs
        const websiteIds = publisherWebsites.map(website => website.id);
        console.log(`[Available Orders] Looking for orders in websites: [${websiteIds.join(', ')}]`);

        // Get orders for currently owned websites
        let currentWebsiteOrders = [];
        if (websiteIds.length > 0) {
          currentWebsiteOrders = await strapi.entityService.findMany('api::order.order', {
            filters: {
              $and: [
                { website: { id: { $in: websiteIds } } },
                { orderStatus: 'pending' },
                { advertiser: { id: { $ne: user.id } } }, // Exclude orders placed by this user as advertiser
                // Show orders that are unassigned OR assigned to this user
                {
                  $or: [
                    { publisher: { $null: true } },
                    { publisher: { id: user.id } }
                  ]
                }
              ]
            },
            populate: ['website', 'advertiser', 'outsourcedContent', 'orderContent'],
            sort: { orderDate: 'desc' }
          });
        }

        // ALSO get orders for websites that were transferred FROM this user
        // These are orders that were already visible to them before the transfer
        const transferredWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
          where: {
            publisherEmail: user.email,
            submissionStatus: 'ownership_transferred'
          }
        });

        console.log(`[Debug] User ${user.email} has ${transferredWebsites.length} transferred websites`);

        let historicalOrders = [];
        if (transferredWebsites.length > 0) {
          console.log(`[Available Orders] Found ${transferredWebsites.length} transferred websites for user ${user.id}`);

          for (const transferredWebsite of transferredWebsites) {
            // Find the current marketplace listing for this URL
            const currentMarketplaceListing = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { url: transferredWebsite.url, status: 'active' }
            });

            if (currentMarketplaceListing && transferredWebsite.ownershipTransferredAt) {
              // Get pending orders placed BEFORE the transfer date
              const preTransferOrders = await strapi.entityService.findMany('api::order.order', {
                filters: {
                  website: { id: currentMarketplaceListing.id },
                  orderStatus: 'pending',
                  publisher: null,
                  orderDate: { $lt: transferredWebsite.ownershipTransferredAt },
                  advertiser: { id: { $ne: user.id } }
                },
                populate: ['website', 'advertiser', 'outsourcedContent', 'orderContent'],
                sort: { orderDate: 'desc' }
              });

              console.log(`[Available Orders] Found ${preTransferOrders.length} pre-transfer orders for ${transferredWebsite.url}`);
              historicalOrders = historicalOrders.concat(preTransferOrders);
            }
          }
        }

        // ALSO get pending orders where user is directly assigned via snapshot email
        // This catches orders for websites where ownership transferred but order was placed when user owned it
        const directlyAssignedOrders = await strapi.entityService.findMany('api::order.order', {
          filters: {
            $and: [
              { websitePublisherEmail: user.email },
              { orderStatus: 'pending' },
              { advertiser: { id: { $ne: user.id } } },
              {
                $or: [
                  { publisher: { $null: true } },
                  { publisher: { id: user.id } }
                ]
              }
            ]
          },
          populate: ['website', 'advertiser', 'outsourcedContent', 'orderContent'],
          sort: { orderDate: 'desc' }
        });
        console.log(`[Available Orders] Found ${directlyAssignedOrders.length} orders via snapshot email ${user.email}`);

        // Combine all sources: current + historical + directly assigned via snapshot
        const combinedOrders = [...currentWebsiteOrders, ...historicalOrders, ...directlyAssignedOrders];

        // Remove duplicates (in case of any overlap)
        orders = combinedOrders.filter((order, index, self) =>
          index === self.findIndex(o => o.id === order.id)
        );

        console.log(`Retrieved ${orders.length} available orders for user ID ${user.id} (${currentWebsiteOrders.length} current + ${historicalOrders.length} historical + ${directlyAssignedOrders.length} via snapshot)`);

        // Log all order IDs for debugging
        console.log('Available order IDs:', orders.map(order => order.id).join(', '));

        return {
          data: orders,
          meta: {
            count: orders.length
          }
        };
      } catch (error) {
        console.error('Error fetching available orders:', error);
        return ctx.internalServerError('An error occurred while fetching available orders');
      }
    },

    // Accept an order (for publishers)
    async acceptOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;

        // Use the order service to handle order acceptance
        const updatedOrder = await strapi.service('api::order.order').acceptOrder(id, user);

        // Check if user has a publisher wallet, create if not exists
        await checkPublisherWallet(user.id);

        // Create notification for advertiser
        try {
          console.log(`[OrderController] About to create order_accepted notification for order ${updatedOrder.id}`);
          console.log(`[OrderController] Publisher (current user): ${user.id}, Advertiser: ${updatedOrder.advertiser?.id || updatedOrder.advertiser}`);
          console.log(`[OrderController] Full updatedOrder.advertiser object:`, JSON.stringify(updatedOrder.advertiser, null, 2));

          const advertiserId = updatedOrder.advertiser?.id || updatedOrder.advertiser;
          if (!advertiserId) {
            console.error(`[OrderController] ERROR: No advertiser ID found in updatedOrder!`);
            console.error(`[OrderController] updatedOrder:`, JSON.stringify(updatedOrder, null, 2));
            throw new Error('No advertiser ID found in order');
          }

          await strapi.service('api::notification.notification').createOrderNotification(
            updatedOrder.id,
            user.id,
            advertiserId,
            'order_accepted'
          );

          console.log(`[OrderController] Order accepted notification created successfully for advertiser ${advertiserId}`);
        } catch (notificationError) {
          console.error('Failed to create order accepted notification:', notificationError);
          // Don't fail the order acceptance if notification fails
        }

        // Send email notification for order acceptance
        try {
          // Get the updated order with full data for email
          const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
            populate: ['website', 'advertiser', 'publisher']
          });

          // Get advertiser user data
          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: updatedOrder.advertiser?.id || updatedOrder.advertiser }
          });

          if (advertiserUser && advertiserUser.email) {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendOrderAcceptanceEmail(
              fullOrder,
              advertiserUser.email,
              user.email
            );
            console.log(`Order acceptance emails sent for order ${id}`);
          }
        } catch (emailError) {
          console.error('Failed to send order acceptance emails:', emailError);
          // Don't fail the acceptance if email fails
        }

        return {
          data: updatedOrder,
          meta: {
            message: 'Order accepted successfully'
          }
        };
      } catch (error) {
        console.error('Error accepting order:', error);

        // Handle specific service errors
        if (error.message === 'Order not found') {
          return ctx.notFound('Order not found');
        }
        if (error.message === 'Order is already accepted or not available') {
          return ctx.badRequest('Order is already accepted or not available');
        }
        if (error.message === 'You do not have permission to accept this order') {
          return ctx.forbidden('You do not have permission to accept this order');
        }

        return ctx.internalServerError('An error occurred while accepting the order');
      }
    },

    // Reject an order (for publishers)
    async rejectOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        const { body } = ctx.request;

        if (!body.reason || body.reason.trim().length === 0) {
          return ctx.badRequest('Rejection reason is required');
        }

        // Get the order
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['website', 'advertiser', 'publisher']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if order is in pending status
        if (order.orderStatus !== 'pending') {
          return ctx.badRequest('Only pending orders can be rejected');
        }

        // Verify the publisher can reject this order using ORDER's snapshot data
        // NOT live marketplace data (which may have changed due to ownership transfer)
        // This matches the approach used in acceptOrder
        if (order.advertiser !== user.id) {
          const isDirectPublisher = order.publisher && (order.publisher.id === user.id || order.publisher === user.id);
          const isSnapshotPublisher = order.websitePublisherEmail === user.email;

          if (!isDirectPublisher && !isSnapshotPublisher) {
            console.log(`[Reject Order] User ${user.id} (${user.email}) denied access to order ${id}`);
            console.log(`[Reject Order] Order publisher: ${order.publisher?.id}, Snapshot email: ${order.websitePublisherEmail}`);
            return ctx.forbidden('You do not have permission to reject this order');
          }
        }

        // Use the order service to handle escrow refund before updating the order status
        await strapi.service('api::order.order').rejectOrder(id, user);

        // Update the order with rejection details
        const updatedOrder = await strapi.db.query('api::order.order').update({
          where: { id },
          data: {
            orderStatus: 'rejected',
            rejectedDate: new Date(),
            rejectionReason: body.reason.trim()
          }
        });

        // Create notification for advertiser about the rejection
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            order.id,
            user.id,
            order.advertiser?.id || order.advertiser,
            'order_rejected',
            { reason: body.reason.trim() }
          );
        } catch (notificationError) {
          console.error('Failed to create order rejected notification:', notificationError);
          // Don't fail the order rejection if notification fails
        }

        // Send email notification for order rejection
        try {
          // Get the updated order with full data for email
          const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
            populate: ['website', 'advertiser', 'publisher']
          });

          // Get advertiser user data
          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.advertiser?.id || order.advertiser }
          });

          if (advertiserUser && advertiserUser.email) {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendOrderRejectionEmail(
              { ...fullOrder, rejectionReason: body.reason.trim() },
              advertiserUser.email,
              user.email
            );
            console.log(`Order rejection emails sent for order ${id}`);
          }
        } catch (emailError) {
          console.error('Failed to send order rejection emails:', emailError);
          // Don't fail the rejection if email fails
        }

        return {
          data: updatedOrder,
          meta: {
            message: 'Order rejected successfully'
          }
        };
      } catch (error) {
        console.error('Error rejecting order:', error);
        return ctx.internalServerError('An error occurred while rejecting the order');
      }
    },

    // Mark order as delivered (for publishers)
    async deliverOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        const { body } = ctx.request;
        console.log("user", user);
        console.log(id);

        // Get the order - make sure we populate the publisher field
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['website', 'advertiser', 'publisher', 'outsourcedContent']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }
        console.log("order", order);

        // Initialize a flag to track if we need to update publisher
        let publisherNeedsUpdate = false;

        // Check if the order doesn't have a publisher yet
        if (!order.publisher || !order.publisher.id) {
          console.log(`Order ${id} has no publisher assigned. Assigning current user as publisher.`);
          publisherNeedsUpdate = true;

          // First check if this user is allowed to deliver this order
          let canDeliver = false;

          // If the order is for a website owned by this user
          if (order.website && order.website.id) {
            const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: {
                id: order.website.id,
                $or: [
                  { publisher: user.id },
                  { publisher_email: user.email }
                ]
              }
            });

            if (isWebsiteOwner) {
              console.log('User owns this website. Assigning as publisher.');
              canDeliver = true;
            }
          }

          // Or if they are the advertiser for their own order
          if (order.advertiser && order.advertiser.id === user.id) {
            console.log('User is the advertiser for this order. Assigning as publisher too.');
            canDeliver = true;
          }

          if (!canDeliver) {
            return ctx.forbidden('You do not have permission to deliver this order.');
          }

          // Update the order to set the user as the publisher
          await strapi.db.query('api::order.order').update({
            where: { id },
            data: {
              publisher: user.id
            }
          });

          // Set the publisher value in our order object
          if (!order.publisher) {
            order.publisher = { id: user.id };
          } else {
            order.publisher.id = user.id;
          }

          // Ensure publisher wallet exists
          await checkPublisherWallet(user.id);
        }

        // Check for publisher mismatch (should only happen if publisherNeedsUpdate is false)
        if (!publisherNeedsUpdate && order.publisher && order.publisher.id !== user.id) {
          console.log('Publisher mismatch:', {
            orderId: id,
            orderPublisher: order.publisher.id,
            currentUser: user.id
          });

          // Check if this is the advertiser's own order
          if (order.advertiser && order.advertiser.id === user.id) {
            console.log('User is the advertiser for this order. Fixing publisher association...');
            publisherNeedsUpdate = true;
          }
          // Special case: Check if the website belongs to this user
          else if (order.website && order.website.id) {
            // Check if user is the current website owner for NEW orders only
            // For historical orders, only the originally assigned publisher can deliver
            const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: {
                id: order.website.id,
                $or: [
                  { publisher: user.id },
                  { publisher_email: user.email }
                ]
              }
            });

            if (isWebsiteOwner) {
              // Only allow website owner to take over if this is a very recent order (within 24 hours)
              // This prevents ownership transfers from stealing old orders
              const orderAge = new Date() - new Date(order.orderDate);
              const maxAgeForOwnerTakeover = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

              if (orderAge <= maxAgeForOwnerTakeover) {
                console.log('User owns this website and order is recent. Allowing publisher association...');
                publisherNeedsUpdate = true;
              } else {
                console.log(`Order is too old (${Math.round(orderAge / (1000 * 60 * 60))} hours) for automatic publisher assignment.`);
                return ctx.forbidden('This order was placed before your ownership. Only the originally assigned publisher can deliver it.');
              }
            } else {
              return ctx.forbidden('You do not have permission to update this order. You are neither the publisher nor the website owner.');
            }
          } else {
            return ctx.forbidden('You do not have permission to update this order. Publisher ID does not match your user ID.');
          }

          // Update the publisher if needed
          if (publisherNeedsUpdate) {
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                publisher: user.id
              }
            });

            // Update our order object
            if (!order.publisher) {
              order.publisher = { id: user.id };
            } else {
              order.publisher.id = user.id;
            }
          }
        }

        // Check if the order is in pending status
        let statusNeedsUpdate = false;

        if (order.orderStatus === 'pending') {
          console.log(`Order ${id} is in pending status. Updating to accepted first.`);
          statusNeedsUpdate = true;

          // Update to accepted
          await strapi.db.query('api::order.order').update({
            where: { id },
            data: {
              orderStatus: 'accepted',
              acceptedDate: new Date()
            }
          });

          // Update our order object
          order.orderStatus = 'accepted';
        } else if (order.orderStatus !== 'accepted') {
          return ctx.badRequest(`Order must be in "accepted" or "pending" status to be marked as delivered (current status: ${order.orderStatus})`);
        }

        // For outsourced orders, check if we need to link outsourced content
        if (order.isOutsourced) {
          // Check if outsourced content exists for this order
          const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
            where: { order: id }
          });

          // If outsourced content exists but is not linked to order, update the association
          if (outsourcedContent && !order.outsourcedContent) {
            console.log(`Found outsourced content (${outsourcedContent.id}) not linked to order. Linking now.`);
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                outsourcedContent: outsourcedContent.id
              }
            });
          }
          // If outsourced content doesn't exist, create it
          else if (!outsourcedContent) {
            console.log(`No outsourced content found for order ${id}. Creating now.`);
            // Get website details for the project name
            let projectName = `Order for ${order.description}`;
            if (order.website && order.website.url) {
              projectName = order.website.url;
            }

            // Create new outsourced content
            const newOutsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
              data: {
                projectName,
                instructions: order.instructions || 'No specific instructions provided',
                order: id,
                publishedAt: new Date()
              }
            });

            // Link the outsourced content to the order
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                outsourcedContent: newOutsourcedContent.id
              }
            });
          }
          // If outsourced content exists but doesn't have instructions, update it
          else if (outsourcedContent && !outsourcedContent.instructions && order.instructions) {
            console.log(`Updating instructions for outsourced content ${outsourcedContent.id}`);
            await strapi.entityService.update('api::outsourced-content.outsourced-content', outsourcedContent.id, {
              data: {
                instructions: order.instructions
              }
            });
          }
        }

        // Now mark as delivered
        console.log(`Marking order ${id} as delivered.`);
        const updatedOrder = await strapi.db.query('api::order.order').update({
          where: { id },
          data: {
            orderStatus: 'delivered',
            deliveredDate: new Date(),
            deliveryProof: body.proof || '',
            deliveryMessage: body.message || '',
            // Only update revision status if it was in progress
            ...(order.revisionStatus === 'in_progress' && {
              revisionStatus: 'completed'
            })
          }
        });

        // Create notification for advertiser about delivery
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            order.id,
            user.id,
            order.advertiser.id,
            'order_delivered',
            { orderId: order.id }
          );

          // Send email notification for order delivery
          try {
            // Get the updated order with full data for email
            const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
              populate: ['website', 'advertiser', 'publisher']
            });

            // Get advertiser user data
            const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
              where: { id: order.advertiser?.id || order.advertiser }
            });

            if (advertiserUser && advertiserUser.email) {
              const emailService = strapi.service('api::global.email-operations');
              await emailService.sendOrderDeliveryEmail(
                fullOrder,
                advertiserUser.email,
                user.email
              );
              console.log(`Order delivery emails sent for order ${id}`);
            }
          } catch (emailError) {
            console.error('Failed to send order delivery emails:', emailError);
            // Don't fail delivery if email fails
          }
        } catch (error) {
          console.error('Failed to create delivery notification:', error);
        }

        // Return the updated order
        return {
          data: updatedOrder
        };
      } catch (error) {
        console.error('Error delivering order:', error);
        return ctx.internalServerError('An error occurred while updating the order');
      }
    },

    // Complete order and release escrow (for advertisers)
    async completeOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        console.log(`Attempting to complete order ${id} by user ${user.id}`);

        // Get the order with related data
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['publisher', 'advertiser']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if user is the advertiser for this order
        if (!order.advertiser || (order.advertiser.id !== user.id && order.advertiser !== user.id)) {
          console.log('Permission denied:', {
            orderId: id,
            orderAdvertiser: order.advertiser?.id || order.advertiser,
            currentUser: user.id
          });
          return ctx.forbidden('You do not have permission to complete this order');
        }

        // Check if order is in 'delivered' status
        if (order.orderStatus !== 'delivered') {
          return ctx.badRequest('Order must be in "delivered" status to be completed');
        }

        try {
          console.log(`Processing completion of order ${id}`);
          // Complete the order and release escrow using the order service
          const completedOrder = await strapi.service('api::order.order').completeOrder(order.id, user);

          // Create notification for publisher about completion
          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              order.id,
              order.publisher?.id || order.publisher,
              user.id,
              'order_completed'
            );
          } catch (notificationError) {
            console.error('Failed to create order completed notification:', notificationError);
            // Don't fail the order completion if notification fails
          }

          // Create payment notification for publisher
          try {
            await strapi.service('api::notification.notification').createPaymentNotification(
              order.publisher?.id || order.publisher,
              'payment_received',
              order.totalAmount
            );

            // Send email notification for order completion with payment
            try {
              const publisherId = order.publisher?.id || order.publisher;
              const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
                where: { id: publisherId }
              });

              if (publisherUser && publisherUser.email) {
                const emailService = strapi.service('api::global.email-operations');
                await emailService.sendOrderCompletionEmail(
                  completedOrder,
                  publisherUser.email,
                  order.totalAmount
                );
                console.log(`Order completion email sent for order ${order.id}`);
              }
            } catch (emailError) {
              console.error('Failed to send order completion email:', emailError);
              // Don't fail completion if email fails
            }
          } catch (notificationError) {
            console.error('Failed to create payment received notification:', notificationError);
            // Don't fail the order completion if notification fails
          }

          return {
            data: completedOrder,
            meta: {
              message: 'Order completed successfully and marked for payment'
            }
          };
        } catch (serviceError) {
          console.error('Service error completing order:', serviceError);
          return ctx.badRequest(serviceError.message || 'Error processing order completion');
        }
      } catch (error) {
        console.error('Error completing order:', error);
        return ctx.internalServerError('An error occurred while completing the order');
      }
    },

    // Dispute an order (for advertisers)
    async disputeOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        const { body } = ctx.request;

        if (!body.reason) {
          return ctx.badRequest('Dispute reason is required');
        }

        // Get the order
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['advertiser']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if user is the advertiser for this order
        // Handle the case where advertiser could be an object or just an ID
        const advertiserId = typeof order.advertiser === 'object' && order.advertiser !== null
          ? order.advertiser.id
          : order.advertiser;

        if (advertiserId !== user.id) {
          return ctx.forbidden('You do not have permission to dispute this order');
        }

        // Check if order is in 'delivered' status
        if (order.orderStatus !== 'delivered') {
          return ctx.badRequest('Only delivered orders can be disputed');
        }

        // Update the order
        const updatedOrder = await strapi.db.query('api::order.order').update({
          where: { id },
          data: {
            orderStatus: 'disputed',
            disputeDate: new Date(),
            disputeReason: body.reason || 'No reason provided'
          }
        });

        // Here you might also want to notify admins about the dispute

        return {
          data: updatedOrder,
          meta: {
            message: 'Order has been marked as disputed'
          }
        };
      } catch (error) {
        console.error('Error disputing order:', error);
        return ctx.internalServerError('An error occurred while disputing the order');
      }
    },

    // Fix missing relations between orders and orderContent
    async fixRelations(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can fix relations');
        }

        let fixed = 0;
        let errors = 0;

        // Find order-contents that have order relation but the order doesn't point back
        const orderContents = await strapi.db.query('api::order-content.order-content').findMany({
          populate: ['order']
        });

        for (const content of orderContents) {
          if (content.order && content.order.id) {
            try {
              // Get the order
              const order = await strapi.db.query('api::order.order').findOne({
                where: { id: content.order.id },
                populate: ['orderContent']
              });

              if (order && !order.orderContent) {
                // Fix the order by adding the missing relation
                await strapi.entityService.update('api::order.order', order.id, {
                  data: {
                    orderContent: content.id
                  }
                });
                fixed++;
                console.log(`Fixed relation for order ${order.id} and content ${content.id}`);
              }
            } catch (err) {
              console.error(`Error fixing relation for content ${content.id}:`, err);
              errors++;
            }
          }
        }

        // Find orders that have missing titles/content
        const ordersWithNoContent = await strapi.db.query('api::order.order').findMany({
          populate: ['orderContent']
        });

        for (const order of ordersWithNoContent) {
          // If order has no orderContent, create one
          if (!order.orderContent) {
            try {
              // Create default content
              const newContent = await strapi.entityService.create('api::order-content.order-content', {
                data: {
                  title: `Order for ${order.description}`,
                  content: order.description || 'Order content',
                  minWordCount: 1000,
                  order: order.id
                }
              });

              // Update the order to point to the new content
              await strapi.entityService.update('api::order.order', order.id, {
                data: {
                  orderContent: newContent.id
                }
              });

              fixed++;
              console.log(`Created missing content for order ${order.id}`);
            } catch (err) {
              console.error(`Error creating content for order ${order.id}:`, err);
              errors++;
            }
          }
        }

        return {
          data: {
            fixed,
            errors,
            message: `Fixed ${fixed} relations, encountered ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error fixing relations:', error);
        return ctx.internalServerError('An error occurred while fixing relations');
      }
    },

    // Migrate instructions from orders to outsourced content
    async migrateInstructions(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can migrate instructions');
        }

        let fixed = 0;
        let created = 0;
        let errors = 0;

        // Find outsourced orders with instructions
        const outsourcedOrders = await strapi.db.query('api::order.order').findMany({
          where: { isOutsourced: true },
          populate: ['outsourcedContent']
        });

        console.log(`Found ${outsourcedOrders.length} outsourced orders to process`);

        for (const order of outsourcedOrders) {
          try {
            // If order has instructions
            if (order.instructions) {
              // If order has linked outsourced content, update it
              if (order.outsourcedContent) {
                await strapi.entityService.update('api::outsourced-content.outsourced-content', order.outsourcedContent.id, {
                  data: {
                    instructions: order.instructions
                  }
                });
                fixed++;
                console.log(`Updated instructions for outsourced content ${order.outsourcedContent.id}`);
              }
              // If order doesn't have linked outsourced content, create one
              else {
                // Get website details for the project name
                let projectName = `Order for ${order.description}`;
                if (order.website) {
                  const website = await strapi.db.query('api::marketplace.marketplace').findOne({
                    where: { id: order.website }
                  });
                  if (website && website.url) {
                    projectName = website.url;
                  }
                }

                // Create new outsourced content
                const newOutsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
                  data: {
                    projectName,
                    instructions: order.instructions,
                    order: order.id,
                    publishedAt: new Date()
                  }
                });

                // Link the outsourced content to the order
                await strapi.entityService.update('api::order.order', order.id, {
                  data: {
                    outsourcedContent: newOutsourcedContent.id
                  }
                });

                created++;
                console.log(`Created new outsourced content for order ${order.id}`);
              }
            }
          } catch (err) {
            console.error(`Error migrating instructions for order ${order.id}:`, err);
            errors++;
          }
        }

        return {
          data: {
            fixed,
            created,
            errors,
            message: `Updated ${fixed} existing outsourced content entries, created ${created} new entries, encountered ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error migrating instructions:', error);
        return ctx.internalServerError('An error occurred while migrating instructions');
      }
    },

    // Request a revision for an order
    async requestRevision(ctx) {
      const { orderId } = ctx.params;
      const { message } = ctx.request.body;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to request a revision');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['advertiser', 'publisher'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the advertiser for this order
        if (order.advertiser?.id !== user.id) {
          return ctx.forbidden('Only the advertiser can request revisions');
        }

        // Validate 5-day window for requesting revisions
        if (order.deliveredDate) {
          const deliveredDate = new Date(order.deliveredDate);
          const currentDate = new Date();
          const daysDifference = Math.floor((currentDate - deliveredDate) / (1000 * 60 * 60 * 24));

          if (daysDifference > 5) {
            return ctx.badRequest('Revision can only be requested within 5 working days of delivery');
          }
        } else {
          return ctx.badRequest('Order has not been delivered yet');
        }

        // Update order status and set revision timestamps
        const updated = await strapi.entityService.update('api::order.order', orderId, {
          data: {
            orderStatus: 'accepted',
            revisionRequestedAt: new Date(),
            revisionDeadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
            revisionStatus: 'requested',
          }
        });

        // Create a communication record for the revision request
        await strapi.entityService.create('api::communication.communication', {
          data: {
            message: `Revision requested: ${message}`,
            sender: user.id,
            order: orderId,
            communicationStatus: 'requested',
          }
        });

        // Create notification for publisher about revision request
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            orderId,
            order.publisher?.id,
            user.id,
            'revision_requested',
            { reason: message }
          );
        } catch (notificationError) {
          console.error('Failed to create revision requested notification:', notificationError);
          // Don't fail the revision request if notification fails
        }

        // Send email notification for revision request
        try {
          // Get the updated order with full data for email
          const fullOrder = await strapi.entityService.findOne('api::order.order', orderId, {
            populate: ['website', 'advertiser', 'publisher']
          });

          // Get publisher and advertiser user data
          const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.publisher?.id || order.publisher }
          });

          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.advertiser?.id || order.advertiser }
          });

          if (publisherUser && advertiserUser) {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendRevisionRequestEmail(
              { ...fullOrder, revisionMessage: message },
              publisherUser.email,
              advertiserUser.email
            );
            console.log(`Revision request emails sent for order ${orderId}`);
          }
        } catch (emailError) {
          console.error('Failed to send revision request emails:', emailError);
          // Don't fail the revision request if email fails
        }

        return {
          success: true,
          data: updated
        };
      } catch (error) {
        console.error('Error requesting revision:', error);
        return ctx.internalServerError('An error occurred while requesting revision');
      }
    },

    // Start working on a revision (for publishers)
    async startRevision(ctx) {
      const { orderId } = ctx.params;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to start a revision');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['publisher', 'advertiser'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the publisher for this order
        if (order.publisher?.id !== user.id) {
          return ctx.forbidden('Only the publisher can start working on revisions');
        }

        // Update order revision status
        const updated = await strapi.entityService.update('api::order.order', orderId, {
          data: { revisionStatus: 'in_progress' }
        });

        // Create a communication record
        await strapi.entityService.create('api::communication.communication', {
          data: {
            message: 'Working on revision',
            sender: user.id,
            order: orderId,
            communicationStatus: 'in_progress',
          }
        });

        // Create notification for advertiser about revision start
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            orderId,
            user.id,
            order.advertiser?.id,
            'revision_in_progress',
            { message: 'Publisher has started working on the revision' }
          );
        } catch (notificationError) {
          console.error('Failed to create revision in progress notification:', notificationError);
          // Don't fail the revision start if notification fails
        }

        return {
          success: true,
          data: updated
        };
      } catch (error) {
        console.error('Error starting revision:', error);
        return ctx.internalServerError('An error occurred while starting revision');
      }
    },

    // Mark a revision as completed (for publishers)
    async completeRevision(ctx) {
      const { orderId } = ctx.params;
      const { message, deliveryProof } = ctx.request.body;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to complete a revision');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['publisher', 'advertiser'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the publisher for this order
        if (order.publisher?.id !== user.id) {
          return ctx.forbidden('Only the publisher can complete revisions');
        }

        // Prepare update data
        const updateData = {
          revisionStatus: 'completed',
          orderStatus: 'delivered',
          deliveredDate: new Date()
        };

        // Add delivery proof if provided
        if (deliveryProof) {
          updateData.deliveryProof = deliveryProof;
        }

        // Add delivery message if provided
        if (message) {
          updateData.deliveryMessage = message;
        }

        // Update order revision status and order status
        const updated = await strapi.entityService.update('api::order.order', orderId, {
          data: updateData
        });

        // Create a communication record
        await strapi.entityService.create('api::communication.communication', {
          data: {
            message: `Revision completed: ${message}`,
            sender: user.id,
            order: orderId,
            communicationStatus: 'acceptance',
          }
        });

        // Create notification for advertiser about revision completion
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            orderId,
            user.id,
            order.advertiser?.id,
            'revision_completed'
          );
        } catch (notificationError) {
          console.error('Failed to create revision completed notification:', notificationError);
          // Don't fail the revision completion if notification fails
        }

        return {
          success: true,
          data: updated
        };
      } catch (error) {
        console.error('Error completing revision:', error);
        return ctx.internalServerError('An error occurred while completing revision');
      }
    },

    // Migrate existing orders to populate marketplace snapshot data
    async migrateSnapshots(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can migrate snapshots');
        }

        let migrated = 0;
        let errors = 0;
        let skipped = 0;

        console.log('Starting marketplace snapshot migration for existing orders...');

        // Find orders that don't have snapshot data yet
        const ordersToMigrate = await strapi.db.query('api::order.order').findMany({
          where: {
            websiteSnapshot: null
          },
          populate: ['website']
        });

        console.log(`Found ${ordersToMigrate.length} orders to migrate`);

        for (const order of ordersToMigrate) {
          try {
            if (!order.website || !order.website.id) {
              console.log(`Order ${order.id} has no website relation, skipping`);
              skipped++;
              continue;
            }

            // Get the current marketplace data (this is the best we can do for historical data)
            const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { id: order.website.id }
            });

            if (!marketplace) {
              console.log(`Marketplace not found for order ${order.id}, skipping`);
              skipped++;
              continue;
            }

            // Create snapshot data
            const websiteSnapshot = {
              id: marketplace.id,
              url: marketplace.url,
              price: marketplace.price,
              link_insertion_price: marketplace.link_insertion_price,
              min_word_count: marketplace.min_word_count,
              guidelines: marketplace.guidelines,
              backlink_type: marketplace.backlink_type,
              backlink_validity: marketplace.backlink_validity,
              category: marketplace.category,
              other_category: marketplace.other_category,
              publisher_name: marketplace.publisher_name,
              publisher_email: marketplace.publisher_email,
              publisher_price: marketplace.publisher_price,
              tat: marketplace.tat,
              dofollow_link: marketplace.dofollow_link,
              fast_placement_status: marketplace.fast_placement_status,
              ahrefs_dr: marketplace.ahrefs_dr,
              ahrefs_traffic: marketplace.ahrefs_traffic,
              ahrefs_rank: marketplace.ahrefs_rank,
              moz_da: marketplace.moz_da,
              language: marketplace.language,
              countries: marketplace.countries,
              forbidden_gp_price: marketplace.forbidden_gp_price,
              forbidden_li_price: marketplace.forbidden_li_price,
              publisher_forbidden_gp_price: marketplace.publisher_forbidden_gp_price,
              publisher_forbidden_li_price: marketplace.publisher_forbidden_li_price,
              publisher_link_insertion_price: marketplace.publisher_link_insertion_price,
              semrush_authority_score: marketplace.semrush_authority_score,
              semrush_traffic: marketplace.semrush_traffic,
              spam_score: marketplace.spam_score,
              adv_crypto_pricing: marketplace.adv_crypto_pricing,
              adv_casino_pricing: marketplace.adv_casino_pricing,
              adv_cbd_pricing: marketplace.adv_cbd_pricing,
              publisher_crypto_pricing: marketplace.publisher_crypto_pricing,
              publisher_casino_pricing: marketplace.publisher_casino_pricing,
              publisher_cbd_pricing: marketplace.publisher_cbd_pricing,
              similarweb_traffic: marketplace.similarweb_traffic,
              ahrefs_referring_domain: marketplace.ahrefs_referring_domain,
              domain_zone: marketplace.domain_zone,
              only_with_us: marketplace.only_with_us,
              blacklist_status: marketplace.blacklist_status,
              sample_post: marketplace.sample_post,
              migratedAt: new Date().toISOString()
            };

            // Update the order with snapshot data
            await strapi.entityService.update('api::order.order', order.id, {
              data: {
                websiteSnapshot: websiteSnapshot,
                websiteUrl: marketplace.url,
                websitePrice: marketplace.price,
                websiteLinkInsertionPrice: marketplace.link_insertion_price,
                websiteMinWordCount: marketplace.min_word_count,
                websiteGuidelines: marketplace.guidelines,
                websiteBacklinkType: marketplace.backlink_type,
                websiteBacklinkValidity: marketplace.backlink_validity,
                websiteCategory: marketplace.category,
                websitePublisherName: marketplace.publisher_name,
                websitePublisherEmail: marketplace.publisher_email,
                websitePublisherPrice: marketplace.publisher_price,
                websiteTat: marketplace.tat,
                websiteDofollowLink: marketplace.dofollow_link,
                websiteFastPlacement: marketplace.fast_placement_status,
                websiteAhrefsDr: marketplace.ahrefs_dr,
                websiteAhrefsTraffic: marketplace.ahrefs_traffic,
                websiteMozDa: marketplace.moz_da,
                websiteLanguage: marketplace.language,
                websiteCountries: marketplace.countries
              }
            });

            migrated++;
            console.log(`Migrated snapshot data for order ${order.id}`);
          } catch (err) {
            console.error(`Error migrating snapshot for order ${order.id}:`, err);
            errors++;
          }
        }

        return {
          data: {
            migrated,
            skipped,
            errors,
            message: `Migration completed: ${migrated} orders migrated, ${skipped} skipped, ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error migrating snapshots:', error);
        return ctx.internalServerError('An error occurred while migrating snapshots');
      }
    },

    // Accept an order as complete (for advertisers)
    async finalizeOrder(ctx) {
      const { orderId } = ctx.params;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to accept an order');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['advertiser', 'publisher'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the advertiser for this order
        if (order.advertiser?.id !== user.id) {
          return ctx.forbidden('Only the advertiser can finalize the order');
        }

        // Check if order is in a state that can be finalized
        const validStates = ['delivered'];
        if (!validStates.includes(order.orderStatus)) {
          return ctx.badRequest(`Order must be in 'delivered' status to be finalized (current status: ${order.orderStatus})`);
        }

        // Check if revision was completed (if there was a revision)
        if (order.revisionRequestedAt && order.revisionStatus && order.revisionStatus !== 'completed') {
          return ctx.badRequest('Cannot finalize order - revision is not completed yet');
        }

        try {
          // Use the order service to complete the order and handle payments
          const completedOrder = await strapi.service('api::order.order').completeOrder(orderId, user);

          // Create a final communication record
          await strapi.entityService.create('api::communication.communication', {
            data: {
              message: 'Order accepted and completed by advertiser',
              sender: user.id,
              order: orderId,
              communicationStatus: 'acceptance',
            }
          });

          // Create notification for publisher about delivery acceptance
          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              orderId,
              order.publisher?.id,
              user.id,
              'delivery_accepted_by_advertiser'
            );
          } catch (notificationError) {
            console.error('Failed to create delivery accepted notification:', notificationError);
            // Don't fail the order finalization if notification fails
          }

          return {
            success: true,
            data: completedOrder,
            meta: {
              message: 'Order finalized successfully and payment processed'
            }
          };
        } catch (serviceError) {
          console.error('Service error finalizing order:', serviceError);
          return ctx.badRequest(serviceError.message || 'Error processing order finalization');
        }
      } catch (error) {
        console.error('Error finalizing order:', error);
        return ctx.internalServerError('An error occurred while finalizing the order');
      }
    },
    // Cancel an order
    async cancelOrder(ctx) {
      const { id } = ctx.params;
      const { reason, cancelledBy } = ctx.request.body;
      const user = ctx.state.user;

      try {
        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        console.log(`[CancelOrder] User ${user.id} requesting cancellation for order ${id}`);

        // 1. Fetch order with relations
        const order = await strapi.entityService.findOne('api::order.order', id, {
          populate: ['advertiser', 'publisher', 'website']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // 2. Validate cancellation permission
        const canCancel = await strapi.service('api::order.order').validateCancellation(order, user.id, cancelledBy);
        if (!canCancel.allowed) {
          return ctx.badRequest(canCancel.reason);
        }

        // 3. Refund escrow to advertiser (buyer)
        const refundAmount = await strapi.service('api::order.order').refundEscrowToAdvertiser(order);

        // 4. Update order status
        const updatedOrder = await strapi.entityService.update('api::order.order', id, {
          data: {
            orderStatus: 'cancelled',
            cancellationReason: reason,
            cancelledBy,
            cancelledAt: new Date()
          }
        });

        // 5. Create audit log
        await strapi.service('api::order.order').createAuditLog(order, 'cancelled', user.id, reason);

        // 6. Send notifications (email + in-app)
        await strapi.service('api::order.order').sendCancellationNotifications(order, cancelledBy, reason);

        return {
          data: {
            order: updatedOrder,
            refundAmount,
            refundedTo: 'advertiser'
          }
        };
      } catch (error) {
        console.error('Error cancelling order:', error);
        return ctx.badRequest('Failed to cancel order');
      }
    },
  };
});
