'use strict';

/**
 * order controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Helper function to ensure a publisher wallet exists
async function ensurePublisherWallet(userId) {
  try {
    // Check if publisher wallet exists
    const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { 
        users_permissions_user: userId,
        type: 'publisher'
      }
    });
    
    // If wallet doesn't exist, create one
    if (!publisherWallet) {
      console.log(`Creating publisher wallet for user ${userId}`);
      const newWallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
        data: {
          users_permissions_user: userId,
          type: 'publisher',
          balance: 0,
          escrowBalance: 0,
          currency: 'USD',
          status: 'active',
          publishedAt: new Date()
        }
      });
      
      console.log(`Created new publisher wallet with ID: ${newWallet.id}`);
    }
  } catch (error) {
    console.error('Error ensuring publisher wallet:', error);
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
          metaDescription, 
          keywords, 
          url, 
          title, 
          instructions, 
          projectName, 
          outsourceLinks, 
          ...orderData 
        } = ctx.request.body.data || ctx.request.body;
        console.log("orderdata",orderData)
        console.log('Creating order with data:1', orderData);
        
        // Check if this is an outsourced content order
        const isOutsourced = !!instructions;
        
        // Validate required fields
        if (!orderData.totalAmount || !orderData.description || !orderData.website) {
          return ctx.badRequest('Missing required fields: totalAmount, description and website are required');
        }

        console.log(typeof orderData.website)
        
        // If website is passed as a string ID, convert it to the proper format
        if (typeof orderData.website === 'string' && !isNaN(parseInt(orderData.website))) {
          console.log(`Website appears to be a string ID: ${orderData.website}, looking up by ID`);
          // Try to find the website by ID
          const websiteId = parseInt(orderData.website);
          const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: websiteId }
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
          const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { url: orderData.website }
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
          const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: orderData.website }
          });
          
          if (!marketplace) {
            return ctx.badRequest(`Website with ID ${orderData.website} not found in marketplace`);
          }
          
          console.log(`Verified website ID ${orderData.website} exists`);
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
              $gt: new Date(Date.now() -  1000)
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
        const orderToCreate = {
          ...orderData,
          advertiser: user.id,
          orderDate: new Date(),
          isOutsourced: isOutsourced,
          instructions: instructions || null
        };

        console.log('Creating order with data:', orderToCreate);
        const order = await strapi.service('api::order.order').create(orderToCreate, user);
        console.log('Order created:', order);
        
        if (!order || !order.documentId) {
          throw new Error('Failed to create order');
        }

        console.log("orders",order)
        
        // Handle outsourced content details if this is an outsourced order
        if (isOutsourced) {
          try {
            console.log('Creating outsourced content details');
            // Create outsourced content details
            const outsourcedContentData = {
              projectName: projectName || `Order for ${orderData.description}`,
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
        
        // Only create content object for non-outsourced orders
        if (!isOutsourced) {
          try {
            // Process order content if needed
            let contentData = {
              // Default required fields
              content: orderData.description || '',
              title: defaultTitle,
              // Default to 1000 words if not specified
              minWordCount: 1000,
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
            // If URL isn't provided but website is, try to use website URL
            else if (!contentData.url && orderData.website) {
              try {
                // Get the website URL to use as the content URL
                const website = await strapi.db.query('api::marketplace.marketplace').findOne({
                  where: { id: orderData.website }
                });
                

                if (website && website.url) {
                  contentData.url = website.url;
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

    // Get current user's orders
    async getMyOrders(ctx) {
      try {
        const user = ctx.state.user;
        
        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { type = 'all' } = ctx.query;
        
        // Build filters based on user type
        const filters = {};
        
        if (type === 'advertiser' || type === 'all') {
          // Include orders where user is advertiser
          filters.$or = filters.$or || [];
          filters.$or.push({ advertiser: user.id });
        }
        
        if (type === 'publisher' || type === 'all') {
          // Include orders where user is publisher
          filters.$or = filters.$or || [];
          filters.$or.push({ publisher: user.id });
        }
        
        console.log(`Fetching orders for user ID ${user.id}, type: ${type}`);
        console.log('Filters:', JSON.stringify(filters));
        
        // Get all orders for this user
        const orders = await strapi.entityService.findMany('api::order.order', {
          filters,
          populate: ['website', 'advertiser', 'publisher', 'orderContent', 'outsourcedContent'],
          sort: { orderDate: 'desc' },
        });
        
        console.log(`Found ${orders.length} orders for user ID ${user.id}`);

        return {
          data: orders
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

        // Get publisher's websites by matching the email
        const publisherWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
          where: { publisher_email: user.email }
        });

        let orders = [];

        if (!publisherWebsites || publisherWebsites.length === 0) {
          // Even if they don't have publisher websites, we can still show orders they created as advertiser
          orders = await strapi.entityService.findMany('api::order.order', {
            filters: {
              advertiser: { id: user.id },
              orderStatus: 'pending',
              publisher: null // No publisher assigned yet
            },
            populate: ['website', 'advertiser', 'outsourcedContent'],
            sort: { orderDate: 'desc' }
          });

          if (orders.length === 0) {
          return {
            data: [],
            meta: {
              message: 'No websites found for this publisher and no orders created as advertiser'
            }
          };
        }
        } else {
        // Get website IDs
        const websiteIds = publisherWebsites.map(website => website.id);

        // Find all pending orders:
        // 1. Orders for publisher's websites
        // 2. Orders created by this user as advertiser
          // Get website orders
          const websiteOrders = await strapi.entityService.findMany('api::order.order', {
            filters: {
              website: { id: { $in: websiteIds } },
                orderStatus: 'pending',
                publisher: null // No publisher assigned yet
              },
            populate: ['website', 'advertiser', 'outsourcedContent'],
            sort: { orderDate: 'desc' }
          });
          
          // Get advertiser orders
          const advertiserOrders = await strapi.entityService.findMany('api::order.order', {
            filters: {
              advertiser: { id: user.id },
                orderStatus: 'pending',
                publisher: null // No publisher assigned yet
          },
          populate: ['website', 'advertiser', 'outsourcedContent'],
            sort: { orderDate: 'desc' }
          });
          
          // Combine both sets
          orders = [...websiteOrders, ...advertiserOrders];
        }

        console.log(`Retrieved ${orders.length} total available orders for user ID ${user.id}`);
        
        // Log all order IDs for debugging
        console.log('All available order IDs:', orders.map(order => order.id).join(', '));
        
        // No more deduplication - show all available orders exactly as retrieved from Strapi
        // This ensures each order in the database appears in the UI with correct ID
        const uniqueOrders = orders;

        return {
          data: uniqueOrders,
          meta: {
            count: uniqueOrders.length,
            note: publisherWebsites.length === 0 ? 'Showing orders you created as an advertiser' : undefined
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
        
        // Get the order
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['website']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if order is already accepted
        if (order.orderStatus !== 'pending' || order.publisher) {
          return ctx.badRequest('Order is already accepted or not available');
        }

        // Special case: If the user is the advertiser for this order, allow them to accept it themselves
        if (order.advertiser === user.id) {
          console.log('User is accepting their own order as both advertiser and publisher');
          
          // Update the order
          const updatedOrder = await strapi.db.query('api::order.order').update({
            where: { id },
            data: {
              publisher: user.id,
              orderStatus: 'accepted',
              acceptedDate: new Date()
            }
          });

          // Check if user has a publisher wallet, create if not exists
          await ensurePublisherWallet(user.id);

          return {
            data: updatedOrder,
            meta: {
              message: 'Order accepted successfully (self-assignment)'
            }
          };
        }

        // Normal case: Verify the publisher owns this website
        const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
          where: { id: order.website.id, publisher_email: user.email }
        });

        if (!isWebsiteOwner) {
          return ctx.forbidden('You do not have permission to accept this order');
        }

        // Update the order
        const updatedOrder = await strapi.db.query('api::order.order').update({
          where: { id },
          data: {
            publisher: user.id,
            orderStatus: 'accepted',
            acceptedDate: new Date()
          }
        });

        // Check if user has a publisher wallet, create if not exists
        await ensurePublisherWallet(user.id);

        return {
          data: updatedOrder,
          meta: {
            message: 'Order accepted successfully'
          }
        };
      } catch (error) {
        console.error('Error accepting order:', error);
        return ctx.internalServerError('An error occurred while accepting the order');
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
              where: { id: order.website.id, publisher_email: user.email }
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
          await ensurePublisherWallet(user.id);
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
            const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { id: order.website.id, publisher_email: user.email }
            });
            
            if (isWebsiteOwner) {
              console.log('User owns this website. Fixing publisher association...');
              publisherNeedsUpdate = true;
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
            deliveryProof: body.proof || ''
          }
        });

        return {
          data: updatedOrder,
          meta: {
            message: 'Order marked as delivered'
          }
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
          populate: ['publisher'],
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
      const { message } = ctx.request.body;
      
      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to complete a revision');
        }
        
        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['publisher'],
        });
        
        if (!order) {
          return ctx.notFound('Order not found');
        }
        
        // Ensure user is the publisher for this order
        if (order.publisher?.id !== user.id) {
          return ctx.forbidden('Only the publisher can complete revisions');
        }
        
        // Update order revision status
        const updated = await strapi.entityService.update('api::order.order', orderId, {
          data: { revisionStatus: 'completed' }
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
        
        return { 
          success: true,
          data: updated
        };
      } catch (error) {
        console.error('Error completing revision:', error);
        return ctx.internalServerError('An error occurred while completing revision');
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
  };
});
