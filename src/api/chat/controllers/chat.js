'use strict';

const fs = require('fs');

module.exports = {
  /** GET /chat/order/:orderId/timeline — order status events for the inline timeline (parties only). */
  async timeline(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service('api::chat.chat');
    const order = await svc.order(ctx.params.orderId); if (!order || !svc.party(order, user.id)) return ctx.notFound('Order not found.');
    const knex = strapi.db.connection;
    const logs = await knex('order_audit_logs as a').join('order_audit_logs_order_lnk as l', 'l.order_audit_log_id', 'a.id').where('l.order_id', order.id)
      .select('a.id', 'a.action', 'a.previous_status as previousStatus', 'a.new_status as newStatus', 'a.reason', 'a.timestamp', 'a.created_at as createdAt').orderBy('a.timestamp', 'asc').limit(200);
    const events = [{ key: 'created', at: order.createdAt, label: 'Order placed' }];
    if (order.acceptedDate) events.push({ key: 'accepted', at: order.acceptedDate, label: 'Order accepted' });
    if (order.revisionRequestedAt) events.push({ key: 'revision', at: order.revisionRequestedAt, label: 'Revision requested' });
    if (order.deliveredDate) events.push({ key: 'delivered', at: order.deliveredDate, label: 'Delivered — awaiting approval' });
    if (order.completedDate) events.push({ key: 'completed', at: order.completedDate, label: 'Order completed' });
    for (const a of logs) {
      const label = a.action === 'cancelled' ? 'Order cancelled' : a.action === 'rejected' ? 'Order rejected' : a.action === 'disputed' ? 'Dispute opened' : a.action === 'completed' && /Auto-approved/i.test(a.reason || '') ? 'Auto-approved (no response within the review window)' : null;
      if (label) events.push({ key: `audit_${a.id}`, at: a.timestamp || a.createdAt, label, reason: a.reason || null });
    }
    const seen = new Set(); const out = events.filter((e) => { const k = `${e.key}`; if (seen.has(k)) return false; seen.add(k); return !!e.at; }).sort((x, y) => new Date(x.at) - new Date(y.at));
    // review deadline for delivered orders (auto-approve window)
    let autoApproveAt = null;
    if (order.orderStatus === 'delivered' && order.deliveredDate) { const cfg = await strapi.db.query('api::global-config.global-config').findOne({}); autoApproveAt = new Date(new Date(order.deliveredDate).getTime() + (Math.max(1, parseInt(cfg?.autoApproveDays, 10) || 5)) * 86400000); }
    // delivery deadline. websiteTat is stored in HOURS (the order controller
    // writes `marketplace.tat * 24` on create), so this multiplies by an hour.
    // It used to multiply by a day, which turned a 7-day TAT into "due in 5
    // months" in the chat header. (2026-09-28)
    const dueAt = order.acceptedDate && order.websiteTat
      ? new Date(new Date(order.acceptedDate).getTime() + Number(order.websiteTat) * 3600000)
      : null;
    ctx.body = { data: { orderId: order.id, status: order.orderStatus, events: out, autoApproveAt, dueAt } };
  },

  /** POST /chat/order/:orderId/read — mark the other side's messages read; tell them (read receipt). */
  async markRead(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service('api::chat.chat');
    const order = await svc.order(ctx.params.orderId); if (!order || !svc.party(order, user.id)) return ctx.notFound('Order not found.');
    const knex = strapi.db.connection; const now = new Date();
    const ids = await knex('communications as c').join('communications_order_lnk as co', 'co.communication_id', 'c.id').join('communications_sender_lnk as cs', 'cs.communication_id', 'c.id')
      .where('co.order_id', order.id).whereNot('cs.user_id', user.id).whereNull('c.read_at').pluck('c.id');
    if (ids.length) await knex('communications').whereIn('id', ids).update({ read_at: now, is_unread: false, updated_at: now });
    const other = svc.other(order, user.id);
    if (other && strapi.io?.emitToUser) strapi.io.emitToUser(other, `user_${other}_message`, { type: 'messages_read', orderId: order.id, readAt: now.toISOString(), messageIds: ids });
    ctx.body = { data: { marked: ids.length, readAt: now } };
  },

  /** POST /chat/order/:orderId/attachments (multipart "file", optional "message") → a communication row carrying the attachment. */
  async upload(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service('api::chat.chat');
    const order = await svc.order(ctx.params.orderId); if (!order || !svc.party(order, user.id)) return ctx.notFound('Order not found.');
    if (['cancelled', 'rejected', 'refunded'].includes(order.orderStatus)) return ctx.badRequest('This order is closed.');
    const files = ctx.request.files || {}; const f = files.file || files.files || Object.values(files)[0];
    const file = Array.isArray(f) ? f[0] : f; if (!file) return ctx.badRequest('Attach a file.');
    let meta; try { meta = svc.storeFile(order.id, file); } catch (e) { return ctx.badRequest(e.message); }
    const text = String(ctx.request.body?.message || '').trim().slice(0, 2000);
    let chatroomId = order.chatroom?.id || null;
    if (!chatroomId) { const cr = await strapi.entityService.create('api::chatroom.chatroom', { data: { order: order.id, advertiser: order.advertiser?.id, publisher: order.publisher?.id, status: 'active', lastActivity: new Date() } }); chatroomId = cr.id; }
    const entity = await strapi.entityService.create('api::communication.communication', { data: { message: text || `📎 ${meta.name}`, sender: user.id, order: order.id, chatroom: chatroomId, communicationStatus: 'requested', isUnread: true, attachments: [meta] } });
    const attachments = [{ index: 0, name: meta.name, size: meta.size, mime: meta.mime, url: `/api/chat/attachments/${entity.id}/0` }];
    const payload = { type: 'new_message', chatroomId, orderId: order.id, message: { id: entity.id, content: entity.message, sender: { id: user.id }, createdAt: entity.createdAt, isUnread: true, attachments } };
    const other = svc.other(order, user.id);
    if (other && strapi.io?.emitToUser) strapi.io.emitToUser(other, `user_${other}_message`, payload);
    try { if (other) await strapi.service('api::notification.notification').createCommunicationNotification(other, user.id, order.id, 'message_received', { communicationId: entity.id }); } catch (e) { /* non-fatal */ }
    ctx.body = { data: { id: entity.id, message: entity.message, createdAt: entity.createdAt, attachments } };
  },

  /** GET /chat/attachments/:communicationId/:index — parties only; streams the private file. */
  async download(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service('api::chat.chat');
    const comm = await strapi.db.query('api::communication.communication').findOne({ where: { id: parseInt(ctx.params.communicationId, 10) || 0 }, populate: { order: { select: ['id'] } } });
    if (!comm || !comm.order) return ctx.notFound();
    const order = await svc.order(comm.order.id); if (!order || !svc.party(order, user.id)) return ctx.notFound();
    const att = Array.isArray(comm.attachments) ? comm.attachments[parseInt(ctx.params.index, 10) || 0] : null; if (!att) return ctx.notFound();
    const p = svc.filePath(order.id, att.stored); if (!p) return ctx.notFound();
    ctx.set('Content-Type', att.mime || 'application/octet-stream'); ctx.set('Content-Disposition', `${/^image\//.test(att.mime || '') ? 'inline' : 'attachment'}; filename="${att.name.replace(/"/g, '')}"`); ctx.set('Cache-Control', 'private, max-age=3600');
    ctx.body = fs.createReadStream(p);
  },
};
