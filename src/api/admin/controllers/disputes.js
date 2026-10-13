'use strict';

/**
 * POST /admin/orders/:id/resolve-dispute   (2026-10-13)
 * Body: { outcome: 'release' | 'refund' | 'split', buyerRefund?: number, reason: string }
 *
 *  release → publisher is paid as if the buyer had approved (normal completion)
 *  refund  → full refund to the buyer's wallet, order cancelled
 *  split   → buyerRefund goes back to the buyer (same promo/cash mix they paid
 *            with), the rest is paid to the publisher; order completed.
 *
 * Works on orders in 'disputed' (and, for admin corrections, 'delivered').
 * Every money movement happens inside one DB transaction with a row lock,
 * reusing the same wallet/transaction patterns as completeOrder and
 * refundEscrowToAdvertiser. Needs Orders edit permission.
 */
const { getPublisherCommissionRate } = require('../../../constants/commission');

const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function note(orderId, adminId, message) {
  try {
    await strapi.entityService.create('api::communication.communication', {
      data: { sender: adminId, order: orderId, message, publishedAt: new Date() },
    });
  } catch (e) { strapi.log.warn(`[DISPUTE] chat note failed: ${e.message}`); }
}

async function split(orderId, buyerRefund, adminId, reason) {
  let result;
  await strapi.db.transaction(async ({ trx }) => {
    const lock = await trx('orders').where({ id: orderId }).forUpdate().select('id', 'order_status');
    if (!lock.length) throw new Error('Order not found');
    if (!['disputed', 'delivered'].includes(lock[0].order_status)) throw new Error(`Order is ${lock[0].order_status}; only disputed or delivered orders can be split`);
    const order = await strapi.entityService.findOne('api::order.order', orderId, { populate: ['advertiser', 'publisher'] });
    const advertiserId = order.advertiser && order.advertiser.id;
    const publisherId = order.publisher && order.publisher.id;
    if (!advertiserId || !publisherId) throw new Error('Order needs both a buyer and a publisher');
    const total = r2(order.totalAmount);
    const escrowHeld = r2(order.escrowHeld || order.totalAmount);
    const refund = r2(buyerRefund);
    if (!(refund > 0 && refund < total)) throw new Error(`Buyer refund must be more than 0 and less than the order total ($${total})`);
    const existing = await strapi.db.query('api::transaction.transaction').count({ where: { order: orderId, type: 'refund', transactionStatus: 'success' } });
    if (existing > 0) throw new Error('This order already has a refund');

    const aw = await strapi.db.query('api::user-wallet.user-wallet').findOne({ where: { users_permissions_user: advertiserId } });
    if (!aw) throw new Error('Buyer wallet not found');
    let pw = await strapi.db.query('api::user-wallet.user-wallet').findOne({ where: { users_permissions_user: publisherId } });
    if (!pw) {
      pw = await strapi.entityService.create('api::user-wallet.user-wallet', {
        data: { type: 'unified', currency: 'USD', balance: 0, mainBalance: 0, promoBalance: 0, escrowBalance: 0, pendingWithdrawalBalance: 0, users_permissions_user: publisherId, publishedAt: new Date() },
      });
    }

    // Refund in the same promo/cash mix the buyer paid with.
    const sb = (order.metadata && order.metadata.spendingBreakdown) || {};
    const promoSpent = Number(sb.promoSpent || 0); const mainSpent = Number(sb.mainSpent || 0);
    const promoShare = promoSpent + mainSpent > 0 ? promoSpent / (promoSpent + mainSpent) : 0;
    const promoRefund = r2(refund * promoShare); const mainRefund = r2(refund - promoRefund);

    const rate = getPublisherCommissionRate();
    const publisherGross = r2(total - refund);
    const payout = Math.floor(publisherGross * rate * 100) / 100;
    const fee = r2(publisherGross - payout);
    const now = Date.now();

    const escrow = Number(aw.escrowBalance) || 0;
    await strapi.db.query('api::user-wallet.user-wallet').update({
      where: { id: aw.id },
      data: {
        escrowBalance: Math.max(0, r2(escrow - escrowHeld)),
        mainBalance: r2((Number(aw.mainBalance) || 0) + mainRefund),
        promoBalance: r2((Number(aw.promoBalance) || 0) + promoRefund),
        balance: r2((Number(aw.balance) || 0) + refund),
      },
    });
    const tx = (data) => strapi.entityService.create('api::transaction.transaction', { data: { transactionStatus: 'success', gateway: 'system', order: orderId, publishedAt: new Date(), ...data } });
    if (mainRefund > 0) await tx({ type: 'refund', amount: mainRefund, netAmount: mainRefund, fund_source: 'main_fund', gatewayTransactionId: `dispute_refund_main_${orderId}_${now}`, description: `Partial refund (dispute) for order #${orderId}`, user_wallet: aw.id, users_permissions_user: advertiserId });
    if (promoRefund > 0) await tx({ type: 'refund', amount: promoRefund, netAmount: promoRefund, fund_source: 'promo_fund', gatewayTransactionId: `dispute_refund_promo_${orderId}_${now}`, description: `Partial refund to promo credit (dispute) for order #${orderId}`, user_wallet: aw.id, users_permissions_user: advertiserId });
    await tx({ type: 'escrow_release', amount: r2(escrowHeld - refund), netAmount: r2(escrowHeld - refund), fee: 0, gatewayTransactionId: `escrow_release_${orderId}_${now}`, description: `Escrow released to publisher after dispute on order #${orderId}`, user_wallet: aw.id, users_permissions_user: advertiserId });

    await strapi.db.query('api::user-wallet.user-wallet').update({
      where: { id: pw.id },
      data: { mainBalance: r2((Number(pw.mainBalance) || 0) + payout), balance: r2((Number(pw.balance) || 0) + payout) },
    });
    await tx({ type: 'deposit', amount: payout, netAmount: payout, fee: 0, fund_source: 'main_fund', gatewayTransactionId: `earnings_${orderId}_${now}`, description: `Earnings from order #${orderId} (after dispute)`, user_wallet: pw.id, users_permissions_user: publisherId });
    await tx({ type: 'fee', amount: fee, netAmount: fee, fee, gatewayTransactionId: `fee_${orderId}_${now}`, description: `Platform fee for order #${orderId}`, users_permissions_user: publisherId });

    const resolution = { outcome: 'split', buyerRefund: refund, promoRefund, mainRefund, publisherPayout: payout, fee, by: adminId, reason, at: new Date().toISOString() };
    await strapi.db.query('api::order.order').update({
      where: { id: orderId },
      data: { orderStatus: 'completed', completedDate: new Date(), revisionStatus: null, metadata: { ...(order.metadata || {}), disputeResolution: resolution } },
    });
    // 2026-10-14 affiliate: commission only on the part the publisher keeps
    try { await require('../../../services/affiliate').onOrderCompleted(orderId, trx, { baseRatio: total > 0 ? publisherGross / total : 1 }); }
    catch (affErr) { strapi.log.error(`[affiliate] split commission order ${orderId}: ${affErr.message}`); }
    result = { advertiserId, publisherId, resolution };
  });
  return result;
}

module.exports = {
  async resolveDispute(ctx) {
    const id = Number(ctx.params.id);
    const adminId = ctx.state.user.id;
    const { outcome, reason } = ctx.request.body || {};
    const why = String(reason || '').trim();
    if (!['release', 'refund', 'split'].includes(outcome)) return ctx.badRequest('outcome must be release, refund or split');
    if (why.length < 5) return ctx.badRequest('Write a short reason; the buyer and publisher will see it');
    const order = await strapi.entityService.findOne('api::order.order', id, { populate: ['advertiser', 'publisher'] });
    if (!order) return ctx.notFound('Order not found');
    if (!['disputed', 'delivered'].includes(order.orderStatus)) return ctx.badRequest(`Order is ${order.orderStatus}; only disputed (or delivered) orders can be resolved here`);
    const orderService = strapi.service('api::order.order');
    const walletService = strapi.service('api::user-wallet.user-wallet');
    try {
      let summary;
      if (outcome === 'refund') {
        const r = await orderService.cancelOrderAtomic(id, { cancelledBy: 'admin', reason: `Dispute resolved: ${why}`, actorUserId: adminId });
        if (r && r.alreadyTerminal) return ctx.badRequest(`Order is already ${r.currentStatus}`);
        await strapi.db.query('api::order.order').update({ where: { id }, data: { metadata: { ...(order.metadata || {}), disputeResolution: { outcome: 'refund', buyerRefund: r.refundAmount, by: adminId, reason: why, at: new Date().toISOString() } } } });
        summary = `Full refund of $${r.refundAmount} to the buyer's wallet. Order cancelled.`;
        orderService.sendCancellationNotifications(order, 'admin', `Dispute resolved: ${why}`).catch(() => {});
      } else if (outcome === 'release') {
        const prev = order.orderStatus;
        if (prev === 'disputed') await strapi.db.query('api::order.order').update({ where: { id }, data: { orderStatus: 'delivered' } });
        try {
          await orderService.completeOrder(id, ctx.state.user);
        } catch (e) {
          if (prev === 'disputed') await strapi.db.query('api::order.order').update({ where: { id }, data: { orderStatus: 'disputed' } });
          throw e;
        }
        const fresh = await strapi.entityService.findOne('api::order.order', id, {});
        await strapi.db.query('api::order.order').update({ where: { id }, data: { metadata: { ...(fresh.metadata || {}), disputeResolution: { outcome: 'release', by: adminId, reason: why, at: new Date().toISOString() } } } });
        summary = `Payment released to the publisher. Order completed.`;
      } else {
        const r = await split(id, Number(ctx.request.body.buyerRefund), adminId, why);
        summary = `$${r.resolution.buyerRefund} refunded to the buyer, $${r.resolution.publisherPayout} paid to the publisher. Order completed.`;
        try {
          await Promise.all([
            walletService.emitBalanceUpdate(r.advertiserId, 'dispute_resolution', { orderId: id }),
            walletService.emitBalanceUpdate(r.publisherId, 'dispute_resolution', { orderId: id }),
          ]);
        } catch (_) { /* best-effort */ }
      }
      await note(id, adminId, `Dispute resolved by Serpbays: ${summary} Reason: ${why}`);
      try { await orderService.emitOrderUpdate(id, 'dispute_resolved'); } catch (_) { /* best-effort */ }
      ctx.send({ ok: true, outcome, summary });
    } catch (e) {
      strapi.log.error(`[DISPUTE] order ${id} ${outcome} failed: ${e.message}`);
      return ctx.badRequest(e.message || 'Could not resolve the dispute');
    }
  },
};
