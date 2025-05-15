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
        const { content, links,metaDescription,keywords,url,title, ...orderData } = ctx.request.body.data || ctx.request.body;
        
        console.log('Creating order with data:', orderData);
        
        // Validate required fields
        if (!orderData.totalAmount || !orderData.description || !orderData.website) {
          return ctx.badRequest('Missing required fields: totalAmount, description and website are required');
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
        
        // Check for duplicate recent orders to prevent duplicates
        const recentOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            website: orderData.website,
            advertiser: user.id,
            totalAmount: orderData.totalAmount,
            createdAt: {
              $gt: new Date(Date.now() - 60 * 1000) // Orders created in the last 60 seconds
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
        
        // Create the order first
        const order = await strapi.service('api::order.order').create(orderData, user);
        console.log('Order created:', order);
        
        if (!order || !order.id) {
          throw new Error('Failed to create order');
        }
        
        // Define default title for content
        const defaultTitle = `Order for ${orderData.description}`;
        
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

        // Query orders based on user's role (either as advertiser or publisher)
        // Using distinct by ID to prevent duplicates
        const orders = await strapi.db.query('api::order.order').findMany({
          where: {
            $or: [
              { advertiser: user.id },
              { publisher: user.id }
            ]
          },
          populate: ['website', 'advertiser', 'publisher', 'orderContent'],
          orderBy: { orderDate: 'desc' }
        });
        
        // Remove potential duplicates by ID (even though the query should handle this)
        const uniqueOrders = Array.from(new Map(orders.map(order => [order.id, order])).values());
        
        // Add website URL to the order for display purposes
        const enhancedOrders = await Promise.all(uniqueOrders.map(async (order) => {
          if (order.website && order.website.id) {
            try {
              const website = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { id: order.website.id }
              });
              
              if (website) {
                // Add website URL to the order
                return {
                  ...order,
                  websiteUrl: website.url
                };
              }
            } catch (err) {
              console.error(`Error fetching website for order ${order.id}:`, err);
            }
          }
          return order;
        }));

        return {
          data: enhancedOrders,
          meta: {
            count: enhancedOrders.length
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
    }
  };
});
