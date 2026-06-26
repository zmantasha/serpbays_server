'use strict';

/**
 * communication controller.
 *
 * Hardening summary (compared to the original):
 *   - find / findOne / update / delete overridden — the `Authenticated`
 *     role has `find` + `findOne` + `update` permissions on this content
 *     type, and Strapi's default core controllers apply NO row-level
 *     ownership filter. Without overrides, any logged-in user could list
 *     every message on the platform and edit any of them.
 *   - Every response that includes a populated `sender` relation now
 *     allow-lists user fields to { id, username }. Pre-fix, sender came
 *     back as the FULL up_users row (password hash, withdrawalOtp + amount,
 *     paypal/payoneer emails, billing PII, clerk_id, tokenVersion, etc.)
 *     because `entityService` does not honor `private: true`.
 *   - Order populates similarly allow-listed.
 *   - Dead handlers `acceptOrder`, `requestRevision`, `startRevision`,
 *     `completeRevision`, `getUserConversations` removed — they were not
 *     routed but had no auth/IDOR checks, so a future routing change
 *     would have shipped an instant order-completion / wallet-bypass
 *     primitive.
 *   - Input validation on message length and communicationStatus.
 *   - Snapshot-publisher fallback for legacy orders.
 *   - Error responses never echo `error.message` to the caller.
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Tightened 2026-06-25 (PoLP):
//   * SENDER_PUBLIC_FIELDS: dropped 'username' — client UI reads only
//     .sender.id (no username/email refs in serpbays_client chat pages).
//   * COMM/ORDER docId: dropped 'documentId' — Strapi 5 internal handle,
//     never used by the client; exposing it gives external callers a
//     stable cross-endpoint identifier we don't intend to publish.
const SENDER_PUBLIC_FIELDS = ['id'];
const ORDER_PUBLIC_FIELDS_FOR_COMM = ['id', 'orderStatus', 'createdAt'];
const COMM_PUBLIC_FIELDS = [
  'id',
  'message', 'communicationStatus', 'isUnread',
  'createdAt', 'updatedAt',
];

const VALID_STATUS = ['requested', 'acceptance', 'in_progress'];
const MAX_MESSAGE_LENGTH = 5000;

function isPartyToOrder(order, user) {
  if (!order || !user || typeof user.id !== 'number') return false;
  if (order.advertiser && order.advertiser.id === user.id) return true;
  if (order.publisher && order.publisher.id === user.id) return true;
  // Snapshot fallback for legacy orders where publisher FK was never set.
  // Never overrides a present FK.
  if (!order.publisher?.id
      && order.websitePublisherEmail
      && user.email
      && order.websitePublisherEmail === user.email) {
    return true;
  }
  return false;
}

function buildCommOwnershipFilter(user) {
  if (!user || typeof user.id !== 'number') return null;
  const clauses = [
    { order: { advertiser: user.id } },
    { order: { publisher: user.id } },
    { sender: user.id },
  ];
  if (user.email) {
    clauses.push({ order: { websitePublisherEmail: user.email } });
  }
  return { $or: clauses };
}

// Shape the populated-entity for safe return — drops chatroom (internal
// id only; never the relation) and strips sender / order to allow-lists.
function shapeForResponse(populated) {
  if (!populated) return populated;
  const out = {};
  for (const k of COMM_PUBLIC_FIELDS) {
    if (populated[k] !== undefined) out[k] = populated[k];
  }
  if (populated.sender) {
    out.sender = {};
    for (const k of SENDER_PUBLIC_FIELDS) {
      if (populated.sender[k] !== undefined) out.sender[k] = populated.sender[k];
    }
  }
  if (populated.order) {
    out.order = {};
    for (const k of ORDER_PUBLIC_FIELDS_FOR_COMM) {
      if (populated.order[k] !== undefined) out.order[k] = populated.order[k];
    }
  }
  if (populated.chatroom?.id) {
    out.chatroom = { id: populated.chatroom.id };
  }
  return out;
}

module.exports = createCoreController('api::communication.communication', ({ strapi }) => ({

  // ===== Default-route overrides — ownership-gated =====

  async find(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to list communications');
    }
    const ownership = buildCommOwnershipFilter(ctx.state.user);
    if (!ownership) return ctx.unauthorized('Authenticated user missing identity');
    const userFilters = ctx.query?.filters;
    ctx.query = {
      ...ctx.query,
      filters: userFilters ? { $and: [userFilters, ownership] } : ownership,
      fields: COMM_PUBLIC_FIELDS,
      populate: {
        sender: { fields: SENDER_PUBLIC_FIELDS },
      },
    };
    return super.find(ctx);
  },

  async findOne(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to view this communication');
    }
    const { id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Communication not found');
    }
    // `sender: true` would return the full up_users row (email, phone,
    // password hash, withdrawalOtp, paypal_email, billing PII). The
    // post-fetch `shapeForResponse` already strips most of it, but the
    // intermediate row is held in memory uncensored until the strip
    // runs — and a future logger/middleware that snapshots req objects
    // would capture the PII. Allow-list at the query layer too.
    const row = await strapi.db.query('api::communication.communication').findOne({
      where: { id: numericId },
      populate: {
        sender: { select: SENDER_PUBLIC_FIELDS },
        order: {
          populate: {
            advertiser: { select: ['id'] },
            publisher:  { select: ['id'] },
          },
        },
      },
    });
    if (!row) return ctx.notFound('Communication not found');
    const user = ctx.state.user;
    const isSenderSelf = row.sender?.id === user.id;
    const isParty = isPartyToOrder(row.order, user);
    if (!isSenderSelf && !isParty) {
      return ctx.notFound('Communication not found');
    }
    return { data: shapeForResponse(row) };
  },

  async update(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to update this communication');
    }
    const { id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Communication not found');
    }
    const existing = await strapi.db.query('api::communication.communication').findOne({
      where: { id: numericId },
      populate: { sender: { select: ['id'] } },
    });
    if (!existing) return ctx.notFound('Communication not found');
    if (existing.sender?.id !== ctx.state.user.id) {
      // Only the original sender may mutate the row. 404 to defeat
      // enumeration (don't differentiate "exists" from "not yours").
      return ctx.notFound('Communication not found');
    }
    const body = ctx.request.body?.data || ctx.request.body || {};
    // Whitelist mutable fields — caller cannot reassign sender / order /
    // chatroom or any other column.
    const allowed = {};
    if (typeof body.message === 'string') {
      const m = body.message.trim();
      if (m.length === 0 || m.length > MAX_MESSAGE_LENGTH) {
        return ctx.badRequest('message must be 1..' + MAX_MESSAGE_LENGTH + ' chars');
      }
      allowed.message = m;
    }
    if (body.communicationStatus !== undefined) {
      if (!VALID_STATUS.includes(body.communicationStatus)) {
        return ctx.badRequest('Invalid communicationStatus');
      }
      allowed.communicationStatus = body.communicationStatus;
    }
    if (typeof body.isUnread === 'boolean') {
      allowed.isUnread = body.isUnread;
    }
    if (Object.keys(allowed).length === 0) {
      return ctx.badRequest('No mutable fields supplied');
    }
    const updated = await strapi.entityService.update('api::communication.communication', numericId, {
      data: allowed,
      populate: {
        sender: { fields: SENDER_PUBLIC_FIELDS },
        order:  { fields: ORDER_PUBLIC_FIELDS_FOR_COMM },
      },
    });
    return { data: shapeForResponse(updated) };
  },

  async delete(ctx) {
    // Communications are an append-only audit trail of the order
    // conversation. Disallow deletion outright.
    return ctx.forbidden('Communications cannot be deleted');
  },

  // ===== Custom handlers =====

  async create(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to create a communication');
      }

      const data = ctx.request.body?.data || {};

      // Validate required + bounded inputs.
      if (typeof data.message !== 'string') {
        return ctx.badRequest('message must be a string');
      }
      const message = data.message.trim();
      if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
        return ctx.badRequest('message must be 1..' + MAX_MESSAGE_LENGTH + ' chars');
      }
      const orderId = Number(data.order);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return ctx.badRequest('order must be a positive integer');
      }
      const communicationStatus = data.communicationStatus === undefined
        ? 'requested'
        : data.communicationStatus;
      if (!VALID_STATUS.includes(communicationStatus)) {
        return ctx.badRequest('Invalid communicationStatus');
      }

      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        fields: ['id', 'orderStatus', 'createdAt', 'websitePublisherEmail'],
        populate: {
          advertiser: { fields: ['id'] },
          publisher:  { fields: ['id'] },
          chatroom:   { fields: ['id'] },
        },
      });
      if (!order) return ctx.notFound('Order not found');

      if (!isPartyToOrder(order, user)) {
        // 404 not 403 — don't reveal order existence.
        return ctx.notFound('Order not found');
      }

      // Get or create chatroom.
      let chatroomId = order.chatroom?.id || null;
      if (!chatroomId) {
        const created = await strapi.entityService.create('api::chatroom.chatroom', {
          data: {
            order: order.id,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date(),
          },
          fields: ['id'],
        });
        chatroomId = created.id;
      } else {
        await strapi.entityService.update('api::chatroom.chatroom', chatroomId, {
          data: { lastActivity: new Date() },
        });
      }

      const entity = await strapi.entityService.create('api::communication.communication', {
        data: {
          message,
          sender: user.id,
          order: order.id,
          chatroom: chatroomId,
          communicationStatus,
        },
      });

      const populated = await strapi.entityService.findOne('api::communication.communication', entity.id, {
        populate: {
          sender: { fields: SENDER_PUBLIC_FIELDS },
          order:  { fields: ORDER_PUBLIC_FIELDS_FOR_COMM },
          chatroom: { fields: ['id'] },
        },
      });

      // Determine recipient for notification + email (advertiser <-> publisher).
      let recipientId = null;
      if (order.advertiser && order.publisher) {
        if (user.id === order.advertiser.id) recipientId = order.publisher.id;
        else if (user.id === order.publisher.id) recipientId = order.advertiser.id;
      }

      // Notification (fire-and-forget; non-blocking on failure).
      if (recipientId) {
        try {
          await strapi.service('api::notification.notification').createCommunicationNotification(
            recipientId,
            user.id,
            order.id,
            'message_received',
            { communicationId: entity.id }
          );
        } catch (notificationError) {
          strapi.log?.error?.('[communication] notification failed', { error: notificationError.message });
        }
      }

      // Email (fire-and-forget). Fetch only the fields we need on the recipient.
      if (recipientId && message) {
        try {
          const recipient = await strapi.entityService.findOne(
            'plugin::users-permissions.user',
            recipientId,
            // The user schema uses `firstName` (camelCase). `first_name`
            // (snake_case) was a typo Strapi 4 silently ignored; Strapi 5
            // throws ValidationError on the findOne.
            { fields: ['id', 'username', 'email', 'firstName'] }
          );
          if (recipient?.email) {
            const senderRole = user.id === order.advertiser?.id ? 'Advertiser' : 'Publisher';
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendNewMessageEmail({
              receiverEmail: recipient.email,
              receiverName: recipient.firstName || recipient.username || 'User',
              senderRole,
              messageText: message,
              messageTime: populated.createdAt,
              order: {
                id: order.id,
                orderStatus: order.orderStatus,
                createdAt: order.createdAt,
              },
              replyUrl: `${process.env.CLIENT_URL}/orders/order-detail/${order.id}`,
            });
          }
        } catch (emailError) {
          strapi.log?.error?.('[communication] email send failed', { error: emailError.message });
        }
      }

      // WebSocket fan-out to participants (non-blocking).
      try {
        const notificationData = {
          type: 'new_message',
          chatroomId,
          orderId: order.id,
          message: {
            id: entity.id,
            content: message,
            sender: { id: user.id },
            createdAt: populated.createdAt,
            isUnread: true,
          },
        };
        const participantIds = [];
        if (order.advertiser?.id && order.advertiser.id !== user.id) {
          participantIds.push(order.advertiser.id);
        }
        if (order.publisher?.id && order.publisher.id !== user.id) {
          participantIds.push(order.publisher.id);
        }
        for (const pid of participantIds) {
          if (strapi.io?.emitToUser) {
            strapi.io.emitToUser(pid, `user_${pid}_message`, notificationData);
          }
        }
      } catch (websocketError) {
        strapi.log?.error?.('[communication] websocket emit failed', { error: websocketError.message });
      }

      return { data: shapeForResponse(populated) };
    } catch (error) {
      strapi.log?.error?.('[communication] create failed', { error: error.message });
      return ctx.internalServerError('An error occurred while creating the communication');
    }
  },

  async getOrderCommunications(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to view communications');
      }
      const { orderId } = ctx.params;
      const numericId = Number(orderId);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Order not found');
      }

      const order = await strapi.entityService.findOne('api::order.order', numericId, {
        fields: ['id', 'websitePublisherEmail'],
        populate: {
          advertiser: { fields: ['id'] },
          publisher:  { fields: ['id'] },
        },
      });
      if (!order || !isPartyToOrder(order, user)) {
        return ctx.notFound('Order not found');
      }

      const communications = await strapi.entityService.findMany('api::communication.communication', {
        filters: { order: numericId },
        sort: { createdAt: 'asc' },
        fields: COMM_PUBLIC_FIELDS,
        populate: {
          sender: { fields: SENDER_PUBLIC_FIELDS },
        },
      });

      return { data: communications };
    } catch (error) {
      strapi.log?.error?.('[communication] getOrderCommunications failed', { error: error.message });
      return ctx.internalServerError('An error occurred while fetching communications');
    }
  },

  async updateStatus(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to update a communication');
      }
      const { id } = ctx.params;
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Communication not found');
      }
      const { communicationStatus } = ctx.request.body || {};
      if (!VALID_STATUS.includes(communicationStatus)) {
        return ctx.badRequest('Invalid communicationStatus');
      }

      const existing = await strapi.entityService.findOne('api::communication.communication', numericId, {
        fields: ['id'],
        populate: {
          order: {
            fields: ['id', 'websitePublisherEmail'],
            populate: {
              advertiser: { fields: ['id'] },
              publisher:  { fields: ['id'] },
            },
          },
        },
      });
      if (!existing) return ctx.notFound('Communication not found');
      if (!isPartyToOrder(existing.order, user)) {
        return ctx.notFound('Communication not found');
      }

      const updated = await strapi.entityService.update('api::communication.communication', numericId, {
        data: { communicationStatus },
        populate: {
          sender: { fields: SENDER_PUBLIC_FIELDS },
          order:  { fields: ORDER_PUBLIC_FIELDS_FOR_COMM },
        },
      });
      return { data: shapeForResponse(updated) };
    } catch (error) {
      strapi.log?.error?.('[communication] updateStatus failed', { error: error.message });
      return ctx.internalServerError('An error occurred while updating the communication status');
    }
  },
}));
