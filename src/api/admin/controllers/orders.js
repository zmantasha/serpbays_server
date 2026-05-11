'use strict';

/**
 * Admin Orders Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order.order', ({ strapi }) => ({

  /**
   * Get all orders with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const {
        page = 1,
        pageSize = 20,
        sort = 'createdAt:desc',
        search = '',
        status = '',
        advertiserId = '',
        publisherId = '',
        serviceType = ''
      } = ctx.query;

      // Build filters
      const filters = {};

      // Search filter
      if (search) {
        filters.$or = [
          { description: { $containsi: search } },
          { website: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status) {
        filters.orderStatus = status;
      }

      // Service type filter
      if (serviceType) {
        filters.serviceType = serviceType;
      }

      // Advertiser filter
      if (advertiserId) {
        filters.advertiser = advertiserId;
      }

      // Publisher filter
      if (publisherId) {
        filters.publisher = publisherId;
      }

      // Get orders with pagination using db.query
      const orders = await strapi.db.query('api::order.order').findMany({
        where: filters,
        orderBy: sort === 'createdAt:desc' ? { createdAt: 'desc' } : { createdAt: 'asc' },
        offset: (parseInt(page) - 1) * parseInt(pageSize),
        limit: parseInt(pageSize),
        populate: {
          advertiser: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          // Pull only the title from the related order-content row. The
          // rich-text `content` field is intentionally excluded so the
          // list query stays lightweight; the detail screen still hits
          // GET /admin/orders/:id/content for the full body.
          orderContent: {
            fields: ['title']
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::order.order').count({ where: filters });

      ctx.send({
        data: orders,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN ORDERS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch orders');
    }
  },

  /**
   * Get single order with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;
      console.log('[ORDER DETAILS] Fetching order ID:', id);

      // Use simple array populate - Strapi v4 recommended approach
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website']
      });

      if (!order) {
        console.log('[ORDER DETAILS] Order not found:', id);
        return ctx.notFound('Order not found');
      }

      console.log('[ORDER DETAILS] Successfully fetched order');
      ctx.send({
        data: order
      });

    } catch (error) {
      console.error('[ORDER DETAILS ERROR] Message:', error.message);
      console.error('[ORDER DETAILS ERROR] Stack:', error.stack);
      return ctx.internalServerError('Failed to fetch order details');
    }
  },

  /**
   * Update order status (admin action)
   */
  async updateStatus(ctx) {
    try {
      const { id } = ctx.params;
      const { orderStatus, adminNotes, deliveryMessage, deliveryProof } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating order ${id} status to ${orderStatus}`);

      // Stamp the lifecycle timestamp that matches the target status so the
      // email templates show the right date (acceptedDate, deliveredDate,
      // completedDate).
      const lifecycleStamp = {};
      const now = new Date();
      if (orderStatus === 'accepted') lifecycleStamp.acceptedDate = now;
      else if (orderStatus === 'delivered') lifecycleStamp.deliveredDate = now;
      else if (orderStatus === 'completed') lifecycleStamp.completedDate = now;

      // Delivery fields are only meaningful when transitioning to 'delivered'.
      // Anything sent alongside a different status is ignored to avoid leaking
      // values into the wrong lifecycle phase.
      const deliveryFields = {};
      if (orderStatus === 'delivered') {
        if (typeof deliveryMessage === 'string') deliveryFields.deliveryMessage = deliveryMessage;
        if (typeof deliveryProof === 'string') deliveryFields.deliveryProof = deliveryProof;
      }

      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus,
          adminNotes,
          lastStatusUpdate: now,
          ...lifecycleStamp,
          ...deliveryFields
        },
        populate: ['advertiser', 'publisher']
      });

      // Create communication log for status update
      if (orderStatus) {
        await strapi.entityService.create('api::communication.communication', {
          data: {
            sender: ctx.state.user.id,
            order: id,
            message: `Order status updated to ${orderStatus}${adminNotes ? `. Admin notes: ${adminNotes}` : ''}`,
            messageType: 'status_update',
            isAdminMessage: true,
            publishedAt: new Date()
          }
        });
      }

      // Fire the same notification email that the user-facing flow sends, so
      // admin-driven transitions don't go silent. Fire-and-forget so the
      // 1-2s AutoSend round-trip doesn't keep the admin Quick Actions buttons
      // stuck in their disabled/loading state. Errors are logged but never
      // surface to the admin — a mailer hiccup must not roll back the status
      // change.
      if (['accepted', 'delivered', 'completed'].includes(orderStatus)) {
        (async () => {
          try {
            const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
              populate: ['website', 'advertiser', 'publisher']
            });
            const advertiserEmail = fullOrder?.advertiser?.email;
            const publisherEmail = fullOrder?.publisher?.email;
            const emailService = strapi.service('api::global.email-operations');

            if (orderStatus === 'accepted' && advertiserEmail) {
              await emailService.sendOrderAcceptanceEmail(fullOrder, advertiserEmail, publisherEmail);
            } else if (orderStatus === 'delivered' && advertiserEmail) {
              await emailService.sendOrderDeliveryEmail(fullOrder, advertiserEmail, publisherEmail);
            } else if (orderStatus === 'completed' && publisherEmail) {
              await emailService.sendOrderCompletionEmail(fullOrder, publisherEmail, fullOrder.totalAmount);
            }
          } catch (emailError) {
            console.error('[ADMIN ORDER UPDATE STATUS] Email notification failed:', emailError);
          }
        })();
      }

      ctx.send({
        data: updatedOrder
      });

    } catch (error) {
      console.error('[ADMIN ORDER UPDATE STATUS ERROR]', error);
      return ctx.internalServerError('Failed to update order status');
    }
  },

  /**
   * Assign publisher to order
   */
  async assignPublisher(ctx) {
    try {
      const { id } = ctx.params;
      const { publisherId } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} assigning publisher ${publisherId} to order ${id}`);

      // Note: assignment does NOT change orderStatus — there is no 'assigned'
      // value in the schema enum. The order stays in whatever lifecycle stage
      // it's currently in (typically 'pending'); the publisher relation is
      // simply set/replaced.
      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          publisher: publisherId,
          assignedAt: new Date()
        },
        populate: ['advertiser', 'publisher']
      });

      // Create communication log for assignment
      await strapi.entityService.create('api::communication.communication', {
        data: {
          sender: ctx.state.user.id,
          order: id,
          message: `Order assigned to publisher ${updatedOrder.publisher?.username || publisherId}`,
          messageType: 'assignment',
          isAdminMessage: true,
          publishedAt: new Date()
        }
      });

      ctx.send({
        data: updatedOrder
      });

    } catch (error) {
      console.error('[ADMIN ORDER ASSIGN PUBLISHER ERROR]', error);
      return ctx.internalServerError('Failed to assign publisher');
    }
  },

  /**
   * Get order statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const orderQuery = strapi.db.query('api::order.order');

      // Lifecycle: pending → accepted → delivered → approved → completed,
      // with cancelled/rejected/disputed as terminal off-paths. "In progress"
      // = anything mid-flight (accepted/delivered/approved). 'in_progress'
      // is NOT a value in the schema enum, so the previous query was always 0.
      const IN_PROGRESS_STATUSES = ['accepted', 'delivered', 'approved'];

      const [total, pending, inProgress, completed, cancelled] = await Promise.all([
        orderQuery.count(),
        orderQuery.count({ where: { orderStatus: 'pending' } }),
        orderQuery.count({ where: { orderStatus: { $in: IN_PROGRESS_STATUSES } } }),
        orderQuery.count({ where: { orderStatus: 'completed' } }),
        orderQuery.count({ where: { orderStatus: 'cancelled' } }),
      ]);

      // Calculate total revenue
      const revenueData = await orderQuery.findMany({
        where: { orderStatus: 'completed' },
        select: ['totalAmount']
      });
      const totalRevenue = revenueData.reduce((sum, order) => {
        return sum + parseFloat(order.totalAmount || 0);
      }, 0);

      // Get new orders this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await orderQuery.count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      ctx.send({
        total,
        pending,
        // Frontend reads in_progress (snake_case); inProgress kept for any
        // other consumers that might rely on the old shape.
        in_progress: inProgress,
        inProgress,
        completed,
        cancelled,
        totalRevenue: totalRevenue.toFixed(2),
        newThisMonth
      });

    } catch (error) {
      console.error('[ADMIN ORDER STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch order statistics');
    }
  },

  /**
   * Cancel order (admin action). Mirrors the user-facing cancel flow:
   * refund escrow → update status → audit log → notifications. The
   * previous implementation only updated the status, leaving the
   * advertiser's escrow held forever.
   */
  async cancelOrder(ctx) {
    try {
      const adminId = ctx.state.user.id;
      const { id } = ctx.params;
      const { reason } = ctx.request.body || {};

      console.log(`[ADMIN ACTION] Admin ${adminId} cancelling order ${id}. Reason: ${reason}`);

      // 1. Fetch order with relations (the service helpers populate-walk these)
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });
      if (!order) return ctx.notFound('Order not found');

      // 2. Guard against re-cancellation and post-payout states. The refund
      // helper throws on insufficient escrow, but a cleaner upfront error
      // is friendlier than "Insufficient escrow balance: have $0".
      if (order.orderStatus === 'cancelled') {
        return ctx.badRequest('Order is already cancelled');
      }
      if (order.orderStatus === 'completed') {
        return ctx.badRequest('Cannot cancel a completed order — escrow has already been released to the publisher');
      }
      if (order.orderStatus === 'rejected') {
        return ctx.badRequest('Order is already rejected; escrow was refunded at rejection time');
      }

      const orderService = strapi.service('api::order.order');

      // 3. Refund escrow to advertiser. Throws on insufficient escrow,
      // which we surface as a 400 with the underlying message.
      let refundAmount;
      try {
        refundAmount = await orderService.refundEscrowToAdvertiser(order);
      } catch (refundErr) {
        console.error('[ADMIN ORDER CANCEL REFUND ERROR]', refundErr);
        return ctx.badRequest(`Refund failed: ${refundErr.message || 'unknown error'}`);
      }

      // 4. Update order status only after the refund succeeded so the
      // operation is safely retryable on intermittent failures.
      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'cancelled',
          cancellationReason: reason,
          cancelledAt: new Date(),
          cancelledBy: 'admin',
        },
        populate: ['advertiser', 'publisher'],
      });

      // 5. Audit log + chatroom communication entry. Both are best-effort —
      // the cancellation has already happened atomically by this point.
      try {
        await orderService.createAuditLog(order, 'cancelled', adminId, reason);
      } catch (auditErr) {
        console.warn('[ADMIN ORDER CANCEL] audit log failed:', auditErr?.message);
      }
      try {
        await strapi.entityService.create('api::communication.communication', {
          data: {
            sender: adminId,
            order: id,
            message: `Order cancelled by admin. Reason: ${reason || 'No reason provided'}`,
            messageType: 'cancellation',
            isAdminMessage: true,
            publishedAt: new Date(),
          },
        });
      } catch (chatErr) {
        console.warn('[ADMIN ORDER CANCEL] chatroom log failed:', chatErr?.message);
      }

      // 6. Notifications (email + in-app). Also best-effort.
      try {
        await orderService.sendCancellationNotifications(order, 'admin', reason);
      } catch (notifErr) {
        console.warn('[ADMIN ORDER CANCEL] notifications failed:', notifErr?.message);
      }

      ctx.send({
        data: {
          order: updatedOrder,
          refundAmount,
          refundedTo: 'advertiser',
        },
      });
    } catch (error) {
      console.error('[ADMIN ORDER CANCEL ERROR]', error);
      return ctx.internalServerError('Failed to cancel order');
    }
  },

  /**
   * Reject order (admin action) — only pending orders can be rejected.
   * Refunds escrow to advertiser via the order service, then sets
   * orderStatus='rejected' + rejectionReason + rejectedDate.
   */
  async rejectOrder(ctx) {
    try {
      const adminId = ctx.state.user.id;
      const { id } = ctx.params;
      const { reason } = ctx.request.body || {};

      if (!reason || !String(reason).trim()) {
        return ctx.badRequest('Rejection reason is required');
      }

      const existing = await strapi.entityService.findOne('api::order.order', id);
      if (!existing) return ctx.notFound('Order not found');
      if (existing.orderStatus !== 'pending') {
        return ctx.badRequest('Only pending orders can be rejected');
      }

      console.log(`[ADMIN ACTION] Admin ${adminId} rejecting order ${id}. Reason: ${reason}`);

      // Run escrow refund first; if it fails we don't move the status so the
      // operation can be safely retried.
      try {
        await strapi.service('api::order.order').rejectOrder(id, ctx.state.user);
      } catch (err) {
        console.error('[ADMIN ORDER REJECT REFUND ERROR]', err);
        return ctx.internalServerError(`Refund failed: ${err.message || 'unknown error'}`);
      }

      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'rejected',
          rejectionReason: String(reason).trim(),
          rejectedDate: new Date(),
        },
        populate: ['advertiser', 'publisher'],
      });

      try {
        await strapi.entityService.create('api::communication.communication', {
          data: {
            sender: adminId,
            order: id,
            message: `Order rejected by admin. Reason: ${String(reason).trim()}`,
            messageType: 'rejection',
            isAdminMessage: true,
            publishedAt: new Date(),
          },
        });
      } catch (logErr) {
        // Log-only failure — don't fail the request, the order is already rejected.
        console.warn('[ADMIN ORDER REJECT] communication log failed:', logErr?.message);
      }

      ctx.send({ data: updatedOrder });
    } catch (error) {
      console.error('[ADMIN ORDER REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject order');
    }
  },

  /**
   * Get order content (admin access)
   */
  async getOrderContent(ctx) {
    try {
      const { id } = ctx.params;

      // Find the order content for this order
      const orderContent = await strapi.db.query('api::order-content.order-content').findOne({
        where: { order: id },
      });

      // Find the outsourced content for this order
      const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
        where: { order: id },
      });

      ctx.send({
        orderContent,
        outsourcedContent
      });
    } catch (error) {
      console.error('[ADMIN ORDER CONTENT ERROR]', error);
      return ctx.internalServerError('Failed to fetch order content');
    }
  },

  /**
   * Get order chatroom and communications (admin access)
   */
  async getOrderChatroom(ctx) {
    try {
      const { id } = ctx.params;
      console.log('[ADMIN ORDER CHATROOM] Fetching chatroom for order:', id);

      // Find the chatroom for this order
      const chatroom = await strapi.db.query('api::chatroom.chatroom').findOne({
        where: { order: id },
        populate: {
          order: {
            fields: ['id', 'description', 'orderStatus']
          },
          advertiser: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          communications: {
            populate: {
              sender: {
                fields: ['id', 'username', 'email', 'firstName', 'lastName']
              }
            },
            orderBy: { createdAt: 'asc' }
          }
        }
      });

      if (!chatroom) {
        console.log('[ADMIN ORDER CHATROOM] No existing chatroom found, creating new one');
        // Create a new chatroom if it doesn't exist
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['advertiser', 'publisher']
        });

        if (!order) {
          console.log('[ADMIN ORDER CHATROOM] Order not found:', id);
          return ctx.notFound('Order not found');
        }

        // Check if there are existing communications for this order
        const existingCommunications = await strapi.db.query('api::communication.communication').findMany({
          where: { order: id },
          populate: {
            sender: {
              fields: ['id', 'username', 'email', 'firstName', 'lastName']
            }
          },
          orderBy: { createdAt: 'asc' }
        });

        console.log('[ADMIN ORDER CHATROOM] Found existing communications:', existingCommunications.length);

        const newChatroom = await strapi.db.query('api::chatroom.chatroom').create({
          data: {
            order: id,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date()
          }
        });

        // If there are existing communications, link them to the new chatroom
        if (existingCommunications.length > 0) {
          await strapi.db.query('api::chatroom.chatroom').update({
            where: { id: newChatroom.id },
            data: {
              communications: {
                connect: existingCommunications.map(comm => comm.id)
              }
            }
          });
        }

        ctx.send({
          chatroom: newChatroom,
          communications: existingCommunications
        });
      } else {
        // If chatroom exists but has no communications, check for direct communications
        let communications = chatroom.communications || [];

        if (communications.length === 0) {
          // Fallback: get communications directly from the order
          communications = await strapi.db.query('api::communication.communication').findMany({
            where: { order: id },
            populate: {
              sender: {
                fields: ['id', 'username', 'email', 'firstName', 'lastName']
              }
            },
            orderBy: { createdAt: 'asc' }
          });
        }

        ctx.send({
          chatroom,
          communications: communications
        });
      }
    } catch (error) {
      console.error('[ADMIN ORDER CHATROOM ERROR]', error);
      return ctx.internalServerError('Failed to fetch order chatroom');
    }
  },

  /**
   * Send message in order chatroom (admin access)
   */
  async sendMessage(ctx) {
    try {
      const { id } = ctx.params;
      const { message, messageType = 'admin_message' } = ctx.request.body;

      if (!message || message.trim() === '') {
        return ctx.badRequest('Message cannot be empty');
      }

      // Find or create chatroom for this order
      let chatroom = await strapi.db.query('api::chatroom.chatroom').findOne({
        where: { order: id }
      });

      if (!chatroom) {
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['advertiser', 'publisher']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        chatroom = await strapi.db.query('api::chatroom.chatroom').create({
          data: {
            order: id,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date()
          }
        });
      }

      // Create the communication message
      const communication = await strapi.db.query('api::communication.communication').create({
        data: {
          sender: ctx.state.user.id,
          order: id,
          message: message.trim(),
          messageType,
          isAdminMessage: true,
          publishedAt: new Date()
        }
      });

      // Add communication to chatroom
      await strapi.db.query('api::chatroom.chatroom').update({
        where: { id: chatroom.id },
        data: {
          communications: {
            connect: [communication.id]
          },
          lastActivity: new Date()
        }
      });

      // Return the created message with sender info
      const messageWithSender = await strapi.db.query('api::communication.communication').findOne({
        where: { id: communication.id },
        populate: {
          sender: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          }
        }
      });

      ctx.send({
        message: messageWithSender
      });
    } catch (error) {
      console.error('[ADMIN SEND MESSAGE ERROR]', error);
      return ctx.internalServerError('Failed to send message');
    }
  },

  /**
   * Create an order on behalf of an advertiser.
   * Impersonates the advertiser at the service layer by swapping ctx.state.user
   * and delegating to the real user-facing order controller. Every existing
   * guardrail (wallet balance, self-order block, project ownership, website
   * availability) runs unchanged.
   *
   * Request body:
   *   advertiserId: number            (required)
   *   adminReason: string             (required, non-empty)
   *   userConsentType: enum           (required: ticket|email|phone|chat)
   *   userConsentReference: string    (required, non-empty)
   *   ...order fields matching the user-facing POST /api/orders body
   */
  async createOnBehalf(ctx) {
    const adminId = ctx.state.user?.id;
    const payload = ctx.request.body?.data || ctx.request.body || {};
    const {
      advertiserId,
      adminReason,
      userConsentType,
      userConsentReference,
      ...orderBody
    } = payload;

    // --- Input validation (fail before touching anything) ---
    if (!advertiserId) return ctx.badRequest('advertiserId is required');
    if (!adminReason || String(adminReason).trim().length === 0) {
      return ctx.badRequest('adminReason is required');
    }
    if (!userConsentType) return ctx.badRequest('userConsentType is required');
    const allowedConsent = ['ticket', 'email', 'phone', 'chat'];
    if (!allowedConsent.includes(userConsentType)) {
      return ctx.badRequest(`userConsentType must be one of: ${allowedConsent.join(', ')}`);
    }
    if (!userConsentReference || String(userConsentReference).trim().length === 0) {
      return ctx.badRequest('userConsentReference is required');
    }

    // --- Load advertiser ---
    let advertiser;
    try {
      advertiser = await strapi.entityService.findOne('plugin::users-permissions.user', advertiserId, {
        populate: ['role']
      });
    } catch (err) {
      return ctx.badRequest('Invalid advertiserId');
    }
    if (!advertiser) return ctx.notFound('Advertiser not found');
    if (advertiser.blocked) return ctx.badRequest('Advertiser account is blocked');

    console.log(
      `[ADMIN ACTION] Admin ${adminId} creating order on behalf of user ${advertiser.id} (${advertiser.email})`
    );

    // --- Impersonate at the service layer by swapping ctx.state.user/body ---
    const originalUser = ctx.state.user;
    const originalBody = ctx.request.body;
    const originalStatus = ctx.status;

    ctx.state.user = advertiser;
    // The user controller reads `ctx.request.body.data || ctx.request.body`
    // so either shape works. Pass the order body directly.
    ctx.request.body = orderBody;

    let result;
    try {
      result = await strapi.controller('api::order.order').create(ctx);
    } catch (err) {
      console.error('[ADMIN ORDER CREATE ON BEHALF] Underlying controller threw:', err);
      // Restore before exiting so subsequent middleware sees original ctx state
      ctx.state.user = originalUser;
      ctx.request.body = originalBody;
      return ctx.internalServerError(err?.message || 'Failed to create order on behalf');
    } finally {
      ctx.state.user = originalUser;
      ctx.request.body = originalBody;
    }

    // If the underlying controller responded with an error (e.g. insufficient funds,
    // self-order block, validation), ctx.status will be 4xx/5xx and the body is set.
    // Surface it as-is — do NOT stamp audit fields or notify the user.
    if (ctx.status && ctx.status >= 400 && ctx.status !== originalStatus) {
      return;
    }

    const createdOrder = result?.data;
    if (!createdOrder?.id) {
      console.error('[ADMIN ORDER CREATE ON BEHALF] Unexpected result shape:', result);
      return ctx.internalServerError('Order creation returned no data');
    }

    // --- Stamp audit fields on the order (best-effort, non-fatal) ---
    try {
      await strapi.entityService.update('api::order.order', createdOrder.id, {
        data: {
          createdByAdminId: adminId,
          adminReason: String(adminReason).trim(),
          userConsentType,
          userConsentReference: String(userConsentReference).trim()
        }
      });
    } catch (stampErr) {
      // Do not fail the request — the order is live and wallet already debited.
      console.error('[ADMIN ORDER CREATE ON BEHALF] Failed to stamp audit fields:', stampErr);
    }

    // --- Write persisted audit log (best-effort) ---
    try {
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
        data: {
          adminUser: adminId,
          targetUser: advertiser.id,
          action: 'order.create_on_behalf',
          details: {
            orderId: createdOrder.id,
            totalAmount: createdOrder.totalAmount,
            website: createdOrder.website,
            serviceType: createdOrder.serviceType || 'guest_post',
            reason: String(adminReason).trim(),
            consentType: userConsentType,
            consentReference: String(userConsentReference).trim()
          },
          ipAddress: ctx.request.ip || ctx.request.headers?.['x-forwarded-for'] || null,
          userAgent: ctx.request.headers?.['user-agent'] || null
        }
      });
    } catch (auditErr) {
      console.error('[ADMIN AUDIT] Failed to write audit log row:', auditErr);
    }

    // --- Notify advertiser that admin placed an order on their behalf ---
    try {
      const emailService = strapi.service('api::global.email-operations');
      if (emailService && typeof emailService.sendAdminPlacedOrderEmail === 'function') {
        await emailService.sendAdminPlacedOrderEmail({
          advertiser,
          order: createdOrder,
          adminReason: String(adminReason).trim(),
          consentType: userConsentType,
          consentReference: String(userConsentReference).trim()
        });
      } else {
        console.warn('[ADMIN NOTIFY] email-operations.sendAdminPlacedOrderEmail not available — skipping');
      }
    } catch (emailErr) {
      // Non-fatal — the order is placed, user already got the standard order email
      console.error('[ADMIN NOTIFY] Failed to send admin-placed order email:', emailErr);
    }

    return result;
  }

}));
