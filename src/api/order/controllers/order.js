'use strict';

/**
 * order controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

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
        const { content, links, metaDescription, keywords, url, title, requestId, ...orderData } = ctx.request.body.data || ctx.request.body;
        
        console.log('Creating order with data:', orderData);
        
        // Validate required fields
        if (!orderData.totalAmount) {
          return ctx.badRequest('Missing required field: totalAmount is required');
        }
        
        if (!orderData.description) {
          return ctx.badRequest('Missing required field: description is required');
        }
        
        if (!orderData.website) {
          return ctx.badRequest('Missing required field: website is required');
        }
        
        // If website is passed as a string ID, convert it to the proper format
        if (typeof orderData.website === 'string' && !isNaN(parseInt(orderData.website))) {
          orderData.website = parseInt(orderData.website);
        } 
        // If it's a domain name, try to find the corresponding marketplace entry
        else if (typeof orderData.website === 'string') {
          const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { url: orderData.website }
          });
          
          if (!marketplace) {
            return ctx.badRequest(`Website with domain ${orderData.website} not found in marketplace`);
          }
          
          orderData.website = marketplace.id;
        }
        
        // Remove links from orderData if present to prevent conflicts
        if (orderData.links) {
          delete orderData.links;
        }
        
        // Check for existing orders with the same requestId to implement idempotency
        if (requestId) {
          try {
            // Store the requestId directly in the description field instead of using metadata
            // Format: "[requestId:XYZ] Original description"
            const requestIdPrefix = `[requestId:${requestId}]`;
            
            // Check if an order with this requestId already exists using the description field
            const existingOrders = await strapi.db.query('api::order.order').findMany({
              where: {
                description: {
                  $startsWith: requestIdPrefix
                }
              },
              limit: 1,
              populate: ['advertiser', 'publisher', 'website', 'orderContent']
            });
            
            if (existingOrders && existingOrders.length > 0) {
              console.log(`Found existing order with requestId ${requestId}, returning it instead of creating a new one`);
              return {
                data: existingOrders[0],
                meta: {
                  message: 'Order already exists (idempotency match)'
                }
              };
            }
            
            // Modify the description to include the requestId at the beginning
            orderData.description = `${requestIdPrefix} ${orderData.description}`;
            
          } catch (err) {
            console.error('Error checking for duplicate requestId:', err);
            // Continue with order creation even if the duplication check fails
          }
        }
        
        // Check for duplicate recent orders to prevent duplicates
        const recentOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            website: orderData.website,
            advertiser: user.id,
            description: orderData.description,
            totalAmount: orderData.totalAmount,
            // Check for orders created in the last 5 minutes
            createdAt: {
              $gt: new Date(Date.now() - 5 * 60 * 1000)
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
              message: 'Order already exists (duplicate check)'
            }
          };
        }
        
        // Create the order with metadata for idempotency
        const orderToCreate = {
          ...orderData,
          advertiser: user.id,
          orderDate: new Date(),
        };

        console.log('Creating order with data:', JSON.stringify(orderToCreate, null, 2));
        try {
          const order = await strapi.service('api::order.order').create(orderToCreate, user);
          console.log('Order created:', order);
          
          if (!order || !order.id) {
            throw new Error('Failed to create order - order record was not returned');
          }
          
          // Verify and fix the advertiser association if needed
          if (!order.advertiser && user.id) {
            console.log('Order created without advertiser association. Fixing it now...');
            try {
              await strapi.entityService.update('api::order.order', order.id, {
                data: {
                  advertiser: user.id
                }
              });
              console.log(`Successfully associated advertiser ${user.id} with order ${order.id}`);
              
              // Verify the update was successful
              const verifyOrder = await strapi.entityService.findOne('api::order.order', order.id, {
                populate: ['advertiser']
              });
              
              if (!verifyOrder.advertiser) {
                console.error('Advertiser association failed. Database integrity issue detected.');
              } else {
                console.log(`Verified advertiser association: ID ${verifyOrder.advertiser.id}`);
              }
            } catch (updateError) {
              console.error('Failed to update advertiser association:', updateError);
              // Continue with process - we'll try to handle this gracefully
            }
          }
          
          // Define default title for content
          const defaultTitle = `Order for ${orderData.description}`;
          
          // Create order content in a transaction with the order update to ensure atomicity
          let orderContent = null;
          
          try {
            // Process order content if needed
            let contentData = {
              // Default required fields
              content: orderData.description || '',
              title: defaultTitle,
              // Default to 1000 words if not specified
              minWordCount: 1000,
              // Important: establish the relationship with the order
              order: order.id
            };
            
            // Verify order exists in database before trying to create content
            const orderExists = await strapi.db.query('api::order.order').findOne({
              where: { id: order.id }
            });
            
            if (!orderExists) {
              throw new Error(`Order with ID ${order.id} does not exist in database, cannot create content`);
            }
            
            console.log(`Verified order ${order.id} exists, creating content with order relation`);
            
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
                  order: order.id
                };
              }
            }
            
            // Add links if they were provided - ensure it's stored as JSON
            if (links && (Array.isArray(links) || typeof links === 'string')) {
              // Use our formatLinks helper to ensure proper JSON storage
              contentData.links = formatLinks(links);
            } else if (ctx.request.body.links) {
              // Try to get links directly from the request body
              contentData.links = formatLinks(ctx.request.body.links);
            }
            
            // Add other metadata fields if provided
            if (metaDescription) contentData.metaDescription = metaDescription;
            if (keywords) contentData.keywords = keywords;
            if (title) contentData.title = title;
            
            // Add URL if provided or try to use website URL
            if (url) {
              contentData.url = url;
            } else if (orderData.website) {
              try {
                const website = await strapi.db.query('api::marketplace.marketplace').findOne({
                  where: { id: orderData.website }
                });
                if (website && website.url) {
                  contentData.url = website.url;
                }
              } catch (err) {
                console.log('Error fetching website URL:', err);
              }
            }
            
            // Create the order content using entityService directly rather than inside a transaction
            console.log('Creating order content with data:', JSON.stringify(contentData, null, 2));
            orderContent = await strapi.entityService.create('api::order-content.order-content', {
              data: contentData
            });

            if (!orderContent) {
              throw new Error('Failed to create order content');
            }

            console.log(`Successfully created content with ID ${orderContent.id} for order ${order.id}`);

            // Update the order to link to the content
            await strapi.entityService.update('api::order.order', order.id, {
              data: {
                orderContent: orderContent.id
              }
            });

            console.log(`Successfully linked content ${orderContent.id} to order ${order.id}`);
            
          } catch (contentError) {
            console.error('Error creating order content:', contentError);
            // Create a basic content record if the detailed one failed
            try {
              // Verify order still exists before retrying
              const orderStillExists = await strapi.db.query('api::order.order').findOne({
                where: { id: order.id }
              });
              
              if (!orderStillExists) {
                console.error(`Order ${order.id} no longer exists, cannot create fallback content`);
                throw new Error('Order record validation failed');
              }
              
              // Use minimal data for fallback content
              const basicContentData = {
                content: orderData.description || 'Order content',
                title: defaultTitle,
                order: order.id
              };
              
              console.log('Creating fallback content with minimal data:', basicContentData);
              
              const basicContent = await strapi.entityService.create('api::order-content.order-content', {
                data: basicContentData
              });
              
              if (!basicContent) {
                throw new Error('Failed to create even fallback content');
              }
              
              console.log(`Created fallback content with ID ${basicContent.id}`);
              
              // Update the order to link to the basic content
              await strapi.entityService.update('api::order.order', order.id, {
                data: {
                  orderContent: basicContent.id
                }
              });
              
              console.log(`Linked fallback content ${basicContent.id} to order ${order.id}`);
              
              orderContent = basicContent;
            } catch (fallbackError) {
              console.error('Failed to create fallback content:', fallbackError);
              // Continue without content - we'll return the order anyway
            }
          }
          
          // Return a cleaner response with the order data in a flat structure
          // Get the complete order with its relations
          try {
            const populatedOrder = await strapi.entityService.findOne('api::order.order', order.id, {
              populate: ['advertiser', 'publisher', 'website', 'orderContent'],
            });
            
            if (!populatedOrder) {
              throw new Error(`Could not find order with ID ${order.id} for response creation`);
            }
            
            // Create a safe order object that handles missing data
            const safeOrder = {
              id: populatedOrder.id,
              orderDate: populatedOrder.orderDate || new Date().toISOString(),
              orderStatus: populatedOrder.orderStatus || 'pending',
              totalAmount: populatedOrder.totalAmount || 0,
              description: populatedOrder.description || '',
              escrowHeld: populatedOrder.escrowHeld || 0,
              website: populatedOrder.website || null,
              advertiser: populatedOrder.advertiser || { id: user.id, username: user.username || 'Unknown user' },
              publisher: populatedOrder.publisher || null,
              orderContent: populatedOrder.orderContent || null
            };
            
            // Check if the order has a valid advertiser
            if (!safeOrder.advertiser) {
              console.warn(`Order ${order.id} has no advertiser associated. Using current user as fallback.`);
              safeOrder.advertiser = { id: user.id, username: user.username || 'Unknown user' };
            }
            
            // Extract only the needed fields to avoid nested objects that could cause frontend issues
            const cleanOrder = {
              id: safeOrder.id,
              orderDate: safeOrder.orderDate,
              orderStatus: safeOrder.orderStatus,
              totalAmount: safeOrder.totalAmount,
              description: safeOrder.description,
              escrowHeld: safeOrder.escrowHeld,
              websiteId: safeOrder.website?.id,
              websiteUrl: safeOrder.website?.url,
              advertiserId: safeOrder.advertiser?.id || user.id,
              advertiserName: safeOrder.advertiser?.username || user.username || 'Unknown',
              publisherId: safeOrder.publisher?.id,
              publisherName: safeOrder.publisher?.username,
              orderContentId: safeOrder.orderContent?.id,
              contentTitle: safeOrder.orderContent?.title,
              documentId: `order-${safeOrder.id}`
            };
            
            return {
              data: cleanOrder,
              meta: {
                message: 'Order created successfully'
              }
            };
          } catch (responseError) {
            console.error('Error generating response:', responseError);
            
            // Even if we can't format a nice response, return something to avoid a 500 error
            return {
              data: {
                id: order.id,
                orderStatus: 'pending',
                totalAmount: orderData.totalAmount || 0,
                description: orderData.description || '',
                advertiserId: user.id,
                advertiserName: user.username || 'Unknown user',
                documentId: `order-${order.id}`
              },
              meta: {
                message: 'Order created but response formatting had issues',
                warning: 'Some data may be incomplete'
              }
            };
          }
        } catch (serviceError) {
          console.error('Service error creating order:', serviceError);
          if (serviceError.message === 'Insufficient funds') {
            return ctx.badRequest('Insufficient funds in your wallet');
          }
          if (serviceError.message === 'Advertiser wallet not found') {
            return ctx.badRequest('No advertiser wallet found for your account');
          }
          return ctx.badRequest(`Error creating order: ${serviceError.message}`);
        }
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
        
        // Log and return unexpected errors
        console.error('Order creation error:', error);
        return ctx.badRequest('Failed to create order', { error: error.message });
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

    // Get orders for the current user (both advertiser and publisher)
    async getMyOrders(ctx) {
      try {
        const user = ctx.state.user;
        
        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        console.log(`Fetching orders for user ID: ${user.id}, username: ${user.username}`);
        
        // If a specific role filter is provided in the query, use it
        const roleFilter = ctx.query.role;
        let whereCondition;
        
        if (roleFilter === 'advertiser') {
          // Only show orders where user is advertiser
          whereCondition = { advertiser: user.id };
          console.log('Filtering as advertiser only');
        } else if (roleFilter === 'publisher') {
          // Only show orders where user is publisher
          whereCondition = { publisher: user.id };
          console.log('Filtering as publisher only');
        } else {
          // Show all orders for this user (default)
          whereCondition = {
            $or: [
              { advertiser: user.id },
              { publisher: user.id }
            ]
          };
          console.log('Showing all orders (both advertiser and publisher roles)');
        }

        // Query orders based on the determined role filter
        const orders = await strapi.db.query('api::order.order').findMany({
          where: whereCondition,
          populate: ['website', 'advertiser', 'publisher', 'orderContent'],
          orderBy: { orderDate: 'desc' }
        });
        
        console.log(`Found ${orders.length} orders for user ID: ${user.id}`);
        
        // Debug each order
        orders.forEach((order, index) => {
          console.log(`Order ${index + 1}: ID ${order.id}, Advertiser: ${order.advertiser?.id || 'none'}, Publisher: ${order.publisher?.id || 'none'}`);
        });
        
        // Create a flat, clean structure for each order to avoid nested objects
        const cleanOrders = orders.map(order => ({
          id: order.id,
          orderDate: order.orderDate,
          orderStatus: order.orderStatus,
          totalAmount: order.totalAmount,
          description: order.description,
          escrowHeld: order.escrowHeld,
          websiteId: order.website?.id,
          websiteUrl: order.website?.url,
          advertiserId: order.advertiser?.id,
          advertiserName: order.advertiser?.username,
          publisherId: order.publisher?.id,
          publisherName: order.publisher?.username,
          orderContentId: order.orderContent?.id,
          contentTitle: order.orderContent?.title,
          // Add a unique document ID that frontend can use for deduplication
          documentId: `order-${order.id}`
        }));
        
        return {
          data: cleanOrders,
          meta: {
            count: cleanOrders.length,
            roleFilter: roleFilter || 'all'
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

        // Get publisher's websites by matching the email
        const publisherWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
          where: { publisher_email: user.email }
        });

        if (!publisherWebsites || publisherWebsites.length === 0) {
          // Even if they don't have publisher websites, we can still show orders they created as advertiser
          const advertisedOrders = await strapi.db.query('api::order.order').findMany({
            where: {
              advertiser: user.id,
              orderStatus: 'pending',
              publisher: null // No publisher assigned yet
            },
            populate: ['website', 'advertiser'],
            orderBy: { orderDate: 'desc' }
          });

          if (advertisedOrders.length > 0) {
            return {
              data: advertisedOrders,
              meta: {
                count: advertisedOrders.length,
                note: 'Showing orders you created as an advertiser'
              }
            };
          }

          return {
            data: [],
            meta: {
              message: 'No websites found for this publisher and no orders created as advertiser'
            }
          };
        }

        // Get website IDs
        const websiteIds = publisherWebsites.map(website => website.id);

        // Find all pending orders:
        // 1. Orders for publisher's websites
        // 2. Orders created by this user as advertiser
        const orders = await strapi.db.query('api::order.order').findMany({
          where: {
            $or: [
              {
                website: { $in: websiteIds },
                orderStatus: 'pending',
                publisher: null // No publisher assigned yet
              },
              {
                advertiser: user.id,
                orderStatus: 'pending',
                publisher: null // No publisher assigned yet
              }
            ]
          },
          populate: ['website', 'advertiser'],
          orderBy: { orderDate: 'desc' }
        });

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
        
        // Get the order
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['website', 'advertiser']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Enhanced debugging for publisher mismatch
        if (order.publisher !== user.id) {
          console.log('Publisher mismatch:', {
            orderId: id,
            orderPublisher: order.publisher,
            currentUser: user.id
          });
          
          // Check if this is the advertiser's own order
          if (order.advertiser && order.advertiser.id === user.id) {
            console.log('User is the advertiser for this order. Fixing publisher association...');
            
            // Update the order to set the user as the publisher
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                publisher: user.id
              }
            });
            
            // Refresh the order
            const updatedOrder = await strapi.db.query('api::order.order').findOne({
              where: { id }
            });
            
            // Continue with the updated order
            order.publisher = updatedOrder.publisher;
          } else {
            // Special case: Check if the website belongs to this user
            if (order.website && order.website.id) {
              const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { id: order.website.id, publisher_email: user.email }
              });
              
              if (isWebsiteOwner) {
                console.log('User owns this website. Fixing publisher association...');
                
                // Update the order to set the user as the publisher
                await strapi.db.query('api::order.order').update({
                  where: { id },
                  data: {
                    publisher: user.id
                  }
                });
                
                // Refresh the order
                const updatedOrder = await strapi.db.query('api::order.order').findOne({
                  where: { id }
                });
                
                // Continue with the updated order
                order.publisher = updatedOrder.publisher;
              } else {
                return ctx.forbidden('You do not have permission to update this order. You are neither the publisher nor the website owner.');
              }
            } else {
              return ctx.forbidden('You do not have permission to update this order. Publisher ID does not match your user ID.');
            }
          }
        }

        // Now check again if permission issue is fixed
        if (order.publisher !== user.id) {
          return ctx.forbidden('You still do not have permission to update this order after fix attempt.');
        }

        // Check if order is in 'accepted' status
        if (order.orderStatus !== 'accepted') {
          return ctx.badRequest('Order must be in "accepted" status to be marked as delivered');
        }

        // Update the order
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
        
        // Get the order with related data
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['publisher']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if user is the advertiser for this order
        if (order.advertiser !== user.id) {
          return ctx.forbidden('You do not have permission to complete this order');
        }

        // Check if order is in 'delivered' status
        if (order.orderStatus !== 'delivered') {
          return ctx.badRequest('Order must be in "delivered" status to be completed');
        }

        try {
          // Complete the order and release escrow using the order service
          const completedOrder = await strapi.service('api::order.order').completeOrder(order.id, user);

          return {
            data: completedOrder,
            meta: {
              message: 'Order completed successfully and payment released'
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
          where: { id }
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if user is the advertiser for this order
        if (order.advertiser !== user.id) {
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
    
    // Fix data inconsistencies in orders (admin only)
    async cleanupOrders(ctx) {
      try {
        const user = ctx.state.user;
        
        if (!user) {
          return ctx.unauthorized('Authentication required');
        }
        
        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can clean up orders');
        }
        
        let fixed = 0;
        let errors = 0;
        
        // Find all orders
        const allOrders = await strapi.db.query('api::order.order').findMany({
          populate: ['advertiser', 'publisher', 'website', 'orderContent'],
        });
        
        console.log(`Found ${allOrders.length} total orders to check`);
        
        // Identify potential duplicates based on content similarity
        const ordersByFingerprint = {};
        
        allOrders.forEach(order => {
          if (!order.website || !order.advertiser) {
            return; // Skip incomplete orders
          }
          
          const websiteId = order.website.id;
          const advertiserId = order.advertiser.id;
          const amount = order.totalAmount || 0;
          const description = order.description || '';
          
          // Create a unique fingerprint for this order
          const fingerprint = `${websiteId}-${advertiserId}-${amount}-${description}`;
          
          if (!ordersByFingerprint[fingerprint]) {
            ordersByFingerprint[fingerprint] = [];
          }
          
          ordersByFingerprint[fingerprint].push(order);
        });
        
        // Check for duplicates and log them
        const duplicateGroups = [];
        
        for (const [fingerprint, orders] of Object.entries(ordersByFingerprint)) {
          if (orders.length > 1) {
            // We have potential duplicates
            duplicateGroups.push({
              fingerprint,
              count: orders.length,
              orders: orders.map(o => ({ 
                id: o.id, 
                status: o.orderStatus,
                date: o.orderDate
              }))
            });
            
            console.log(`Found ${orders.length} potential duplicates with fingerprint: ${fingerprint}`);
          }
        }
        
        return {
          data: {
            total: allOrders.length,
            potentialDuplicates: duplicateGroups,
            fixed,
            errors,
            message: `Found ${duplicateGroups.length} groups of potential duplicates`
          }
        };
      } catch (error) {
        console.error('Error cleaning up orders:', error);
        return ctx.internalServerError('An error occurred while cleaning up orders');
      }
    }
  };
});

