'use strict';

/**
 * order service
 */

const { createCoreService } = require('@strapi/strapi').factories;
const { getPublisherCommissionRate } = require('../../../constants/commission');

// ─────────────────────────────────────────────────────────────────────────────
// Per-user monotonic seq for order:status_changed pushes. Mirrors the wallet
// emit pattern so the client can drop out-of-order events that arrive after
// a fresher one (reconnect storms, multi-tab races).
// ─────────────────────────────────────────────────────────────────────────────
const orderSeqByUser = new Map();
const nextOrderSeq = (userId) => {
  const k = Number.parseInt(userId, 10);
  const cur = (orderSeqByUser.get(k) || 0) + 1;
  orderSeqByUser.set(k, cur);
  return cur;
};

module.exports = createCoreService('api::order.order', ({ strapi }) => ({
  // Extend the default create method to handle escrow
  async create(data, user) {
    try {
      // Check if user was passed properly
      if (!user) {
        throw new Error('Authentication required');
      }

      // Get user wallet - unified wallet works for both advertiser and publisher
      let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: user.id
        },
        populate: ['users_permissions_user']
      });

      // Use centralized wallet creation
      if (!wallet) {
        console.log(`No advertiser wallet found for user ${user.id}, creating one automatically`);
        try {
          wallet = await strapi.controller('api::user-wallet.user-wallet').getOrCreateWallet(user.id);
          console.log(`Got/created advertiser wallet with ID: ${wallet.id} for user ${user.id}`);
        } catch (walletError) {
          console.error('Failed to get/create advertiser wallet:', walletError);
          throw new Error('Failed to get/create advertiser wallet. Please contact support.');
        }
      }

      // Calculate fee
      const totalAmount = parseFloat(data.totalAmount);
      const escrowHeld = totalAmount;

      // Refresh wallet balance to check current funds
      const freshWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: wallet.id }
      });

      // Check if user has sufficient balance (using separate balance tracking)
      const totalBalance = parseFloat(freshWallet.balance || 0);
      const mainBalance = parseFloat(freshWallet.mainBalance || 0);
      const promoBalance = parseFloat(freshWallet.promoBalance || 0);

      if (!freshWallet || totalBalance < escrowHeld) {
        throw new Error(`Insufficient funds. Available: ${totalBalance}, Required: ${escrowHeld}`);
      }

      console.log('Balance check for order:', {
        totalBalance,
        mainBalance,
        promoBalance,
        escrowHeld
      });

      // Check if user is trying to order from their own website (prevent self-ordering)
      // Check by userId (publisher relation) or email for legacy
      if (data.website && (
        (data.website.publisher && data.website.publisher === user.id) ||
        (!data.website.publisher && data.website.publisher_email === user.email)
      )) {
        throw new Error('You cannot order from your own website. This is not allowed to prevent self-ordering issues.');
      }

      // Create the order with current date
      const orderData = {
        ...data,
        advertiser: user.id,
        escrowHeld,
        orderDate: new Date(),
        orderStatus: 'pending',
      };

      // Debug log to check data format
      console.log('Creating order with data:', orderData);

      // Use database transaction to ensure everything completes or nothing does
      const result = await strapi.db.transaction(async ({ trx }) => {
        // Create the order using the proper format for Strapi service
        const order = await strapi.entityService.create('api::order.order', {
          data: orderData
        });

        // Verify the order was created successfully
        if (!order || !order.id) {
          throw new Error('Failed to create order record');
        }

        console.log('Order created:', order);

        // Refresh wallet data to ensure current balances before money transfer
        const currentWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: wallet.id }
        });

        if (!currentWallet) {
          throw new Error('Wallet not found during money transfer');
        }

        // MONEY FLOW: Use spending priority (promo funds first, then main funds) → Advertiser Escrow
        const spendResult = await strapi.controller('api::user-wallet.user-wallet').spendFunds(
          user.id,
          escrowHeld,
          order.id,
          { description: `Order #${order.id} escrow hold` }
        );

        const currentEscrow = parseFloat(currentWallet.escrowBalance) || 0;
        const newEscrowBalance = currentEscrow + escrowHeld;

        console.log(`[ORDER CREATE] Money Flow for User ${user.id}:`);
        console.log(`  - Wallet ID: ${currentWallet.id} (original: ${wallet.id})`);
        console.log(`  - Spent ${escrowHeld} using priority: Promo ${spendResult.promoSpent}, Main ${spendResult.mainSpent}`);
        console.log(`  - Adding ${escrowHeld} to escrow: ${currentWallet.escrowBalance} → ${newEscrowBalance}`);

        // Store spending breakdown in order metadata for accurate refunds
        await strapi.entityService.update('api::order.order', order.id, {
          data: {
            metadata: {
              spendingBreakdown: {
                promoSpent: spendResult.promoSpent,
                mainSpent: spendResult.mainSpent,
                totalSpent: escrowHeld
              }
            }
          }
        });

        // Update escrow balance
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: currentWallet.id },
          data: {
            escrowBalance: newEscrowBalance
          }
        });

        console.log("current", currentWallet)
        // Verify the update worked
        const verifyWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: currentWallet.id }
        });

        console.log(`[ORDER CREATE] ✅ Wallet updated successfully for order ${order.id}`);
        console.log(`[ORDER CREATE] ✅ Verified - Balance: ${verifyWallet.balance}, Escrow: ${verifyWallet.escrowBalance}`);

        return order;
      });

      return result;
    } catch (error) {
      console.error('Order creation failed:', error);
      // Log error details if available 
      if (error.details && error.details.errors) {
        console.error('Validation errors:', error.details.errors);
      }
      throw error;
    }
  },

  // Get order with all related content
  async getCompleteOrder(id) {
    return await strapi.entityService.findOne('api::order.order', id, {
      populate: ['advertiser', 'publisher', 'website', 'orderContent', 'outsourcedContent', 'transactions'],
    });
  },

  // When an order is delivered, make content readable to the advertiser
  async markAsDelivered(id, deliveryData = {}) {
    const order = await this.getCompleteOrder(id);

    if (!order) {
      throw new Error('Order not found');
    }

    if (order.orderStatus !== 'accepted') {
      throw new Error('Only accepted orders can be marked as delivered');
    }

    // Update with delivery proof if provided
    const updateData = {
      orderStatus: 'delivered',
      deliveryProof: deliveryData.proof || order.deliveryProof,
    };

    // Update the order
    return await strapi.entityService.update('api::order.order', id, {
      data: updateData,
    });
  },

  // When a delivered order is completed: release the advertiser's escrow,
  // credit the publisher's main balance with their commission share, and
  // record matching transactions on both sides — all in ONE database
  // transaction so any failure rolls the lot back.
  //
  // Money flow:
  //   advertiser.escrowBalance  -= order.escrowHeld   (floored at 0)
  //   publisher.mainBalance     += publisherPayout    (totalAmount × COMMISSION_RATE)
  // Audit rows created (so the running-balance UI is balanced on both sides):
  //   escrow_release  → advertiser  (amount = escrowHeld)
  //   deposit         → publisher   (amount = publisherPayout)
  //   fee             → publisher   (amount = 0 today; ready for future commission)
  async completeOrder(id, user) {
    let updatedOrder;
    let websiteIdForSideEffects;
    let advertiserIdForEvent;
    let publisherIdForEvent;

    await strapi.db.transaction(async ({ trx }) => {
      // Audit M5 fix — SELECT … FOR UPDATE on the order row so a concurrent
      // requestRevision/completeRevision/admin write serializes on this lock
      // and is observed after we commit (or we observe its commit, hitting
      // the revisionStatus guard below). Without the lock, a parallel
      // requestRevision could update revisionStatus='requested' AFTER we
      // already read the row but BEFORE we credit the publisher.
      const lockRow = await trx('orders').where({ id }).forUpdate().select('id');
      if (!lockRow || lockRow.length === 0) {
        throw new Error('Order not found');
      }

      // Re-read the order inside the transaction so any concurrent writer
      // sees the row consistently. Populating relations here also avoids a
      // second round-trip later.
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });
      if (!order) {
        throw new Error('Order not found');
      }

      // Idempotency: if the order is already in any terminal state, this is
      // a duplicate call (retry, race, or stale UI). Return the existing
      // order with no side effects. Previously this only checked for
      // 'approved', which is a status that doesn't even exist on the
      // completion path — so a concurrent second call could re-credit the
      // publisher and double-decrement escrow.
      const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'rejected', 'refunded']);
      if (TERMINAL_STATUSES.has(order.orderStatus)) {
        console.log(`[ORDER COMPLETE] Order ${id} already in terminal state '${order.orderStatus}' — no-op.`);
        updatedOrder = order;
        return;
      }

      if (order.orderStatus !== 'delivered') {
        throw new Error(`Only delivered orders can be completed (current status: ${order.orderStatus})`);
      }

      // Audit M5 fix — revision pending guard. completeOrder previously
      // checked only orderStatus. The natural state machine flips status
      // back to 'accepted' on requestRevision, so this was usually safe;
      // but a row-level inconsistency (race, admin edit, future regression)
      // that left orderStatus='delivered' + revisionStatus='requested'/
      // 'in_progress' would silently release escrow against pending work.
      // Block completion until the revision is resolved (the publisher's
      // completeRevision sets revisionStatus='completed', which is allowed).
      if (order.revisionStatus === 'requested' || order.revisionStatus === 'in_progress') {
        throw new Error(
          `Cannot complete order while revision is "${order.revisionStatus}". Publisher must complete the revision first.`
        );
      }
      if (!order.publisher) {
        throw new Error('Order has no assigned publisher');
      }

      const publisherId = order.publisher.id || order.publisher;
      const advertiserId = order.advertiser?.id || order.advertiser;
      if (!advertiserId) {
        throw new Error('Order has no advertiser');
      }
      websiteIdForSideEffects = order.website?.id || order.website || null;

      // Both wallets must exist (the advertiser wallet was created when they
      // deposited funds; the publisher wallet is lazy-created on first
      // payout). Lookups happen inside the transaction so any concurrent
      // wallet edit also gets serialised.
      const advertiserWallet = await strapi.db
        .query('api::user-wallet.user-wallet')
        .findOne({ where: { users_permissions_user: advertiserId } });
      if (!advertiserWallet) {
        throw new Error(`Advertiser wallet not found for user ${advertiserId}`);
      }

      let publisherWallet = await strapi.db
        .query('api::user-wallet.user-wallet')
        .findOne({ where: { users_permissions_user: publisherId } });
      if (!publisherWallet) {
        // Create inside the transaction so it rolls back if anything below
        // fails. createCoreController.getOrCreateWallet() was used before
        // but that helper isn't transaction-aware.
        publisherWallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
          data: {
            type: 'unified',
            currency: 'USD',
            balance: 0,
            mainBalance: 0,
            promoBalance: 0,
            escrowBalance: 0,
            pendingWithdrawalBalance: 0,
            users_permissions_user: publisherId,
            publishedAt: new Date(),
          },
        });
      }

      // Publisher payout = advertiser price × commission rate (configurable
      // via PUBLISHER_COMMISSION_RATE env). Default is 1.0 today; the math
      // here is correct once that changes.
      const COMMISSION_RATE = getPublisherCommissionRate();
      const escrowHeld = Number(order.escrowHeld) || 0;
      const totalAmount = Number(order.totalAmount) || 0;
      const publisherPayout = Math.floor(totalAmount * COMMISSION_RATE);
      const platformFee = totalAmount - publisherPayout;

      // Floor escrow at 0 — protects against historical drift (we've already
      // seen wallets where escrowBalance < escrowHeld) from going negative
      // and propagating bogus state forward.
      const currentEscrow = Number(advertiserWallet.escrowBalance) || 0;
      if (currentEscrow < escrowHeld) {
        strapi.log.warn(
          `[ORDER COMPLETE] Escrow drift on order ${id}: wallet escrow=${currentEscrow}, order escrowHeld=${escrowHeld}. Flooring at 0.`
        );
      }
      const newAdvertiserEscrow = Math.max(0, currentEscrow - escrowHeld);

      console.log(`[ORDER COMPLETE] Order ${id}: advertiser ${advertiserId} escrow ${currentEscrow} → ${newAdvertiserEscrow}; publisher ${publisherId} mainBalance +${publisherPayout} (fee ${platformFee}); status delivered → completed.`);

      // 1) Decrement advertiser escrow.
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: { escrowBalance: newAdvertiserEscrow },
      });

      // 2) Advertiser-side audit row — closes the loop that was previously
      //    missing. Without this, the running-balance UI back-derived a
      //    phantom starting balance (the symptom that surfaced as "$101"
      //    after a $100 deposit on mantasha+3's transaction history).
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'escrow_release',
          amount: escrowHeld,
          netAmount: escrowHeld,
          fee: 0,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `escrow_release_${id}_${Date.now()}`,
          // fund_source enum doesn't include 'escrow'; leave it null and let
          // the row's type='escrow_release' convey the meaning.
          description: `Escrow released to publisher on completion of order #${id}`,
          user_wallet: advertiserWallet.id,
          users_permissions_user: advertiserId,
          order: id,
          publishedAt: new Date(),
        },
      });

      // 3) Credit publisher main balance. Inlined (rather than calling
      //    addMainFunds) so the wallet update + transaction row participate
      //    in this same db.transaction.
      const newPublisherMain = (Number(publisherWallet.mainBalance) || 0) + publisherPayout;
      const newPublisherTotal = (Number(publisherWallet.balance) || 0) + publisherPayout;
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: { mainBalance: newPublisherMain, balance: newPublisherTotal },
      });

      // 4) Publisher-side deposit tx.
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: publisherPayout,
          netAmount: publisherPayout,
          fee: 0,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `earnings_${id}_${Date.now()}`,
          fund_source: 'main_fund',
          description: `Earnings from order #${id}`,
          user_wallet: publisherWallet.id,
          users_permissions_user: publisherId,
          order: id,
          publishedAt: new Date(),
        },
      });

      // 5) Platform fee tx. Amount is the difference between advertiser
      //    price and publisher payout. With the current 1.0 rate this is 0,
      //    but the row is still created for auditability.
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'fee',
          amount: platformFee,
          netAmount: platformFee,
          fee: platformFee,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `fee_${id}_${Date.now()}`,
          description: `Platform fee for order #${id}`,
          users_permissions_user: publisherId,
          order: id,
          publishedAt: new Date(),
        },
      });

      // 6) Flip order status. Done last so an outside observer never sees
      //    'completed' without the wallet writes being committed too — the
      //    transaction guarantees they commit together.
      updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'completed',
          completedDate: new Date(),
          orderAccepted: true,
          revisionStatus: null,
        },
      });

      console.log(`[ORDER COMPLETE] Order ${id} completed atomically.`);
    });

    // Emit real-time wallet updates to BOTH parties — advertiser's escrow
    // dropped, publisher's main balance went up. Fire AFTER commit so the
    // DB state matches what the event advertises.
    try {
      const walletService = strapi.service('api::user-wallet.user-wallet');
      await Promise.all([
        walletService.emitBalanceUpdate(advertiserIdForEvent, 'order_completion', { orderId: id, side: 'advertiser' }),
        walletService.emitBalanceUpdate(publisherIdForEvent, 'order_completion', { orderId: id, side: 'publisher' }),
      ]);
    } catch (_) { /* best-effort */ }

    // Non-critical side effect — fire AFTER the transaction has committed so
    // a TAT-update failure can't roll back the money movement.
    if (websiteIdForSideEffects) {
      strapi.service('api::marketplace.marketplace').updateTATFromCompletedOrders(websiteIdForSideEffects, {
        minOrderCount: 1,
        lookbackDays: 365,
        useWeightedAverage: true,
      })
        .then((result) => {
          if (result) {
            console.log(`TAT updated for website ${websiteIdForSideEffects}: ${result.newTAT} days (${result.placementSpeed})`);
          }
        })
        .catch((error) => {
          console.error(`Failed to update TAT for website ${websiteIdForSideEffects}:`, error);
        });
    }

    return updatedOrder;
  },

  // When an order is rejected, refund escrow to advertiser AND flip status.
  // Both refund and status update happen inside a single transaction with
  // a row-level lock so a concurrent reject / cancel / cron call serializes
  // on the lock and sees the post-commit state (status='rejected') — making
  // the operation idempotent and double-refund-proof.
  async rejectOrder(id, user) {
    return await strapi.db.transaction(async ({ trx }) => {
      // Audit M3 fix — SELECT ... FOR UPDATE on the order row up front so
      // a concurrent reject/cancel/cron is forced to wait for our commit
      // and then observes the new status, hitting the idempotency branch
      // below.
      const locked = await trx('orders').where({ id }).forUpdate().select('order_status');
      if (!locked || locked.length === 0) {
        throw new Error('Order not found');
      }

      // Idempotency / pre-state check (replaces the old generic pending
      // check). Any non-pending status either means the order moved on or
      // a parallel reject already committed — either way, NO refund.
      const currentStatus = locked[0].order_status;
      if (currentStatus !== 'pending') {
        if (['rejected', 'cancelled', 'refunded'].includes(currentStatus)) {
          // Already terminated by another caller — return without refunding.
          // The caller treats this as a no-op; idempotent retry.
          return { alreadyTerminal: true, currentStatus };
        }
        throw new Error('Only pending orders can be rejected');
      }

      // Get the order with all relations (under the lock).
      const order = await this.getCompleteOrder(id);
      console.log("Processing order rejection:", {
        orderId: id,
        status: order.orderStatus,
        escrowHeld: order.escrowHeld
      });

      if (!order) {
        throw new Error('Order not found');
      }

      // Get advertiser ID (handling both object and direct ID references)
      const advertiserId = order.advertiser.id || order.advertiser;

      console.log("Getting advertiser wallet for:", { advertiserId });

      // Get advertiser wallet - unified wallet works for both roles
      const advertiserWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: advertiserId
        }
      });

      if (!advertiserWallet) {
        throw new Error('Advertiser wallet not found');
      }

      console.log("Refunding escrow:", {
        escrowHeld: order.escrowHeld,
        currentBalance: advertiserWallet.balance,
        currentEscrow: advertiserWallet.escrowBalance,
        orderMetadata: order.metadata
      });

      // Check if we have spending breakdown from order metadata
      const spendingBreakdown = order.metadata?.spendingBreakdown;
      const refundAmount = parseFloat(order.escrowHeld);

      if (spendingBreakdown && (spendingBreakdown.promoSpent > 0 || spendingBreakdown.mainSpent > 0)) {
        console.log("Using spending breakdown for accurate refund:", spendingBreakdown);

        // Refund to the correct balance types based on original spending
        const promoRefund = parseFloat(spendingBreakdown.promoSpent || 0);
        const mainRefund = parseFloat(spendingBreakdown.mainSpent || 0);

        // Get current wallet balances
        const currentMainBalance = parseFloat(advertiserWallet.mainBalance || 0);
        const currentPromoBalance = parseFloat(advertiserWallet.promoBalance || 0);

        // Calculate new balances
        const newMainBalance = currentMainBalance + mainRefund;
        const newPromoBalance = currentPromoBalance + promoRefund;
        const newTotalBalance = newMainBalance + newPromoBalance;

        // Update wallet balances directly
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: advertiserWallet.id },
          data: {
            mainBalance: newMainBalance,
            promoBalance: newPromoBalance,
            balance: newTotalBalance
          }
        });

        // Create single consolidated refund transaction
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: refundAmount, // Total refund amount
            netAmount: refundAmount,
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `refund_${order.id}_${Date.now()}`,
            fund_source: promoRefund > mainRefund ? 'promo_fund' : 'main_fund', // Use the dominant fund source
            description: `Refund for rejected order #${order.id} (${promoRefund > 0 && mainRefund > 0 ? 'mixed funds' : promoRefund > 0 ? 'promo funds' : 'main funds'})`,
            user_wallet: advertiserWallet.id,
            users_permissions_user: advertiserId,
            order: order.id,
            metadata: {
              refundBreakdown: {
                promoRefund: promoRefund,
                mainRefund: mainRefund,
                totalRefund: refundAmount
              },
              original_order: order.id
            },
            publishedAt: new Date()
          }
        });

        console.log(`Refunded ${mainRefund} to main balance and ${promoRefund} to promo balance`);
      } else {
        console.log("No spending breakdown found, using fallback refund to main balance");

        // Fallback: Refund entire amount to main balance (old behavior)
        const result = await strapi.controller('api::user-wallet.user-wallet').addMainFunds(
          advertiserId,
          refundAmount,
          {
            type: 'refund',
            description: `Refund for rejected order #${order.id}`,
            gateway: 'system',
            gatewayTransactionId: `refund_${order.id}_${Date.now()}`
          }
        );
      }

      // Validate and reduce escrow balance
      const currentEscrow = parseFloat(advertiserWallet.escrowBalance) || 0;
      if (currentEscrow < refundAmount) {
        console.error(`[ESCROW ERROR] Cannot refund $${refundAmount}, only $${currentEscrow} in escrow!`);
        throw new Error(`Insufficient escrow balance for refund: have $${currentEscrow}, need $${refundAmount}`);
      }

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: currentEscrow - refundAmount
        }
      });

      console.log("Refund transactions created successfully");

      // Audit M3 fix — flip orderStatus INSIDE the transaction so the
      // refund and the status change commit/roll back together. Was
      // previously done in the controller as a separate update, which
      // opened a window where the refund could commit but the status
      // remained 'pending' (next retry would have refunded again — see
      // M3 reproducer; this path was implicitly safe via the
      // refundEscrowToAdvertiser's "insufficient escrow" throw, but
      // we're closing the architectural gap regardless).
      const reason = (user && user.__rejectionReason) || null;
      await strapi.db.query('api::order.order').update({
        where: { id },
        data: {
          orderStatus: 'rejected',
          rejectedDate: new Date(),
          ...(reason ? { rejectionReason: reason } : {}),
        },
      });

      console.log(`Order ${id} rejected and escrow refunded atomically`);
      return order;
    });
  },

  // When an order is accepted by a publisher
  async acceptOrder(id, user) {
    try {
      // Get the order with all relations
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });

      if (!order) {
        throw new Error('Order not found');
      }

      // Check if order is already accepted (only check status, publisher may be pre-assigned)
      if (order.orderStatus !== 'pending') {
        throw new Error('Order is already accepted or not available');
      }

      // Special case: If the user is the advertiser for this order, allow them to accept it themselves
      if (order.advertiser?.id === user.id || order.advertiser === user.id) {
        console.log('User is accepting their own order as both advertiser and publisher');

        // Update the order
        await strapi.entityService.update('api::order.order', id, {
          data: {
            publisher: user.id,
            orderStatus: 'accepted',
            acceptedDate: new Date()
          }
        });

        // Return the order with populated relations
        const updatedOrder = await strapi.entityService.findOne('api::order.order', id, {
          populate: ['advertiser', 'publisher', 'website'],
        });

        return updatedOrder;
      }

      // Normal case: Verify user can accept this order using ORDER's snapshot data
      // NOT live marketplace data (which may have changed due to ownership transfer)
      // User can accept if:
      // 1. They are the directly assigned publisher on this order
      // 2. The order's snapshotted publisher email matches their email
      const isDirectPublisher = order.publisher && (order.publisher.id === user.id || order.publisher === user.id);
      const isSnapshotPublisher = order.websitePublisherEmail === user.email;

      if (!isDirectPublisher && !isSnapshotPublisher) {
        console.log(`[Accept Order] User ${user.id} (${user.email}) denied access to order ${id}`);
        console.log(`[Accept Order] Order publisher: ${order.publisher?.id}, Snapshot email: ${order.websitePublisherEmail}`);
        throw new Error('You do not have permission to accept this order');
      }

      // Update the order
      await strapi.entityService.update('api::order.order', id, {
        data: {
          publisher: user.id,
          orderStatus: 'accepted',
          acceptedDate: new Date()
        }
      });

      // Return the order with populated relations
      const updatedOrder = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });

      console.log(`Order ${id} accepted successfully by publisher ${user.id}`);
      console.log(`Returning order with advertiser:`, updatedOrder.advertiser);
      return updatedOrder;
    } catch (error) {
      console.error('Order acceptance failed:', error);
      throw error;
    }
  },

  // When an order is delivered by a publisher
  async deliverOrder(id, user, deliveryData = {}) {
    try {
      // Get the order with all relations
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });

      if (!order) {
        throw new Error('Order not found');
      }

      // Check if order is in accepted status
      if (order.orderStatus !== 'accepted') {
        throw new Error('Only accepted orders can be marked as delivered');
      }

      // Check if the order has a publisher assigned
      if (!order.publisher || !order.publisher.id) {
        // If no publisher assigned, check if current user can be assigned
        let canDeliver = false;

        // Check using ORDER's snapshot data (not live marketplace which may have changed)
        // User can deliver if the order's snapshotted publisher email matches their email
        if (order.websitePublisherEmail === user.email) {
          console.log(`User ${user.email} matches order snapshot email. Assigning as publisher.`);
          canDeliver = true;
        }

        // Or if they are the advertiser for their own order
        if (order.advertiser && (order.advertiser.id === user.id || order.advertiser === user.id)) {
          console.log('User is the advertiser for this order. Assigning as publisher too.');
          canDeliver = true;
        }

        if (!canDeliver) {
          throw new Error('You do not have permission to deliver this order');
        }

        // Update the order to set the user as the publisher
        await strapi.entityService.update('api::order.order', id, {
          data: {
            publisher: user.id
          }
        });

        // Set the publisher value in our order object
        order.publisher = { id: user.id };
      } else {
        // Check if current user is the assigned publisher
        if (order.publisher.id !== user.id) {
          throw new Error('You are not the assigned publisher for this order');
        }
      }

      // Update with delivery proof if provided
      const updateData = {
        orderStatus: 'delivered',
        deliveryProof: deliveryData.proof || order.deliveryProof,
        deliveredDate: new Date()
      };

      // Update the order
      await strapi.entityService.update('api::order.order', id, {
        data: updateData,
      });

      // Return the order with populated relations
      const updatedOrder = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });

      console.log(`Order ${id} delivered successfully by publisher ${user.id}`);
      console.log(`Returning order with advertiser:`, updatedOrder.advertiser);
      return updatedOrder;
    } catch (error) {
      console.error('Order delivery failed:', error);
      throw error;
    }
  },

  // Cancellation Helper: Validate if order can be cancelled
  async validateCancellation(order, userId, cancelledBy) {
    // System cancellations (cron jobs).
    // Audit M1 defense-in-depth: 'system' MUST NOT be reachable from a
    // controller — if a userId is set, the call came from a user request
    // and the controller failed to derive cancelledBy server-side.
    if (cancelledBy === 'system') {
      if (userId != null) {
        return { allowed: false, reason: 'system cancellation is reserved for cron jobs (no user context)' };
      }
      return { allowed: true };
    }

    // Admin cancellations. The controller derives 'admin' from the caller's
    // role; admins may cancel orders in any pre-completion state (the route
    // is already gated to super_admin). Replaces the legacy practice of
    // using cancelledBy='system' from admin clicks.
    if (cancelledBy === 'admin') {
      const TERMINAL = ['completed', 'cancelled', 'rejected', 'refunded'];
      if (TERMINAL.includes(order.orderStatus)) {
        return { allowed: false, reason: `Order is already ${order.orderStatus}; cannot cancel.` };
      }
      return { allowed: true };
    }

    // Advertiser cancellation rules
    if (cancelledBy === 'advertiser') {
      if (order.advertiser.id !== userId) {
        return { allowed: false, reason: 'Not authorized to cancel this order' };
      }

      // Can cancel if not accepted yet
      if (order.orderStatus === 'pending') {
        return { allowed: true };
      }

      // Can cancel if accepted but not delivered in 7 days
      if (order.orderStatus === 'accepted' && order.acceptedDate) {
        const acceptedDate = new Date(order.acceptedDate);
        const daysSinceAccepted = (Date.now() - acceptedDate) / (1000 * 60 * 60 * 24);

        if (daysSinceAccepted >= 7) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: 'Order already accepted. Cannot cancel until 7 days after acceptance with no delivery.'
        };
      }

      return { allowed: false, reason: 'Order cannot be cancelled at this stage' };
    }

    // Publisher cancellation rules
    if (cancelledBy === 'publisher') {
      // Check if user is the direct publisher OR the website owner via ID or email
      let isPublisher = order.publisher && order.publisher.id === userId;

      if (!isPublisher && order.website) {
        // Check by publisher relation first
        if (order.website.publisher && order.website.publisher === userId) {
          isPublisher = true;
        }
        // Fallback to email for legacy records
        else if (!order.website.publisher && order.website.publisher_email) {
          const userRecord = await strapi.entityService.findOne('plugin::users-permissions.user', userId);
          if (userRecord && userRecord.email === order.website.publisher_email) {
            isPublisher = true;
          }
        }
      }

      if (!isPublisher) {
        return { allowed: false, reason: 'Not authorized to cancel this order' };
      }

      // Can cancel if accepted but not delivered
      if (order.orderStatus === 'accepted') {
        return { allowed: true };
      }

      return { allowed: false, reason: 'Order can only be cancelled after acceptance and before delivery' };
    }

    return { allowed: false, reason: 'Invalid cancellation type' };
  },

  // Cancellation Helper: Refund escrow
  //
  // Audit M7 fix — must be called INSIDE a transaction that holds a row-lock
  // on the order. Two guards prevent double-refund:
  //   (a) Idempotency pre-state check: refuses to refund if a successful
  //       refund tx already exists for this order, OR if the order is
  //       already in a terminal status.
  //   (b) Escrow-amount check: throws (no longer clamps) if the wallet's
  //       escrowBalance is less than the requested refund amount — a
  //       drained-escrow state means a refund already happened.
  // Combined with the row-lock + status-flip-in-same-trx in cancelOrderAtomic
  // / rejectOrder, this makes refunds idempotent and double-refund-proof.
  async refundEscrowToAdvertiser(order) {
    // (a) Idempotency: refuse if a successful refund already exists.
    const existingRefunds = await strapi.db.query('api::transaction.transaction').findMany({
      where: { order: order.id, type: 'refund', transactionStatus: 'success' },
      select: ['id'],
    });
    if (existingRefunds && existingRefunds.length > 0) {
      console.warn(`[REFUND IDEMPOTENT] Order ${order.id} already has ${existingRefunds.length} successful refund tx — skipping.`);
      throw new Error(`Order ${order.id} has already been refunded`);
    }

    // Get advertiser (buyer) wallet
    const advertiserWallet = await strapi.controller('api::user-wallet.user-wallet')
      .getOrCreateWallet(order.advertiser.id);

    const refundAmount = parseFloat(order.totalAmount);
    const currentEscrow = parseFloat(advertiserWallet.escrowBalance) || 0;

    // (b) Escrow-amount check. Previously this was just a warning + clamp,
    // which silently absorbed double-refund attempts (the second call read
    // escrow=0, clamped to 0, but still credited mainBalance another time).
    // Now we throw — a drained escrow means a refund already happened.
    if (currentEscrow < refundAmount) {
      throw new Error(
        `Insufficient escrow for refund on order ${order.id}: have $${currentEscrow}, need $${refundAmount}. Likely already refunded.`
      );
    }

    // Check if order has spending breakdown metadata
    const spendingBreakdown = order.metadata?.spendingBreakdown;

    if (spendingBreakdown && (spendingBreakdown.promoSpent || spendingBreakdown.mainSpent)) {
      // Refund to original sources based on spending breakdown
      const promoRefund = parseFloat(spendingBreakdown.promoSpent || 0);
      const mainRefund = parseFloat(spendingBreakdown.mainSpent || 0);

      console.log(`[Refund] Using spending breakdown: Promo $${promoRefund}, Main $${mainRefund}`);

      const currentMainBalance = parseFloat(advertiserWallet.mainBalance) || 0;
      const currentPromoBalance = parseFloat(advertiserWallet.promoBalance) || 0;
      const currentTotalBalance = parseFloat(advertiserWallet.balance) || 0;

      // Update wallet with refunds to original sources
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          mainBalance: currentMainBalance + mainRefund,
          promoBalance: currentPromoBalance + promoRefund,
          balance: currentTotalBalance + refundAmount, // Update total balance
          escrowBalance: Math.max(0, currentEscrow - refundAmount) // never negative on drift
        }
      });

      // Create refund transactions (one for each source if both were used)
      if (promoRefund > 0) {
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: promoRefund,
            netAmount: promoRefund,
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `refund_promo_${order.id}_${Date.now()}`,
            fund_source: 'promo_fund',
            description: `Refund to promo balance for cancelled order #${order.id}`,
            user_wallet: advertiserWallet.id,
            users_permissions_user: order.advertiser.id,
            order: order.id,
            publishedAt: new Date()
          }
        });
      }

      if (mainRefund > 0) {
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: mainRefund,
            netAmount: mainRefund,
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `refund_main_${order.id}_${Date.now()}`,
            fund_source: 'main_fund',
            description: `Refund to main balance for cancelled order #${order.id}`,
            user_wallet: advertiserWallet.id,
            users_permissions_user: order.advertiser.id,
            order: order.id,
            publishedAt: new Date()
          }
        });
      }

      console.log(`[Refund] $${refundAmount} refunded to advertiser ${order.advertiser.id} (Promo: $${promoRefund}, Main: $${mainRefund})`);
    } else {
      // Fallback: No spending breakdown, refund to main balance only
      console.log(`[Refund] No spending breakdown found, refunding to main balance`);

      const currentMainBalance = parseFloat(advertiserWallet.mainBalance) || 0;
      const currentTotalBalance = parseFloat(advertiserWallet.balance) || 0;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          mainBalance: currentMainBalance + refundAmount,
          balance: currentTotalBalance + refundAmount, // Update total balance
          escrowBalance: Math.max(0, currentEscrow - refundAmount) // never negative on drift
        }
      });

      // Create refund transaction
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'refund',
          amount: refundAmount,
          netAmount: refundAmount,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `refund_order_${order.id}_${Date.now()}`,
          fund_source: 'main_fund',
          description: `Refund for cancelled order #${order.id}`,
          user_wallet: advertiserWallet.id,
          users_permissions_user: order.advertiser.id,
          order: order.id,
          publishedAt: new Date()
        }
      });

      console.log(`[Refund] $${refundAmount} refunded to advertiser ${order.advertiser.id} for order ${order.id}`);
    }

    // Real-time wallet update — advertiser sees refund land instantly.
    try {
      await strapi.service("api::user-wallet.user-wallet").emitBalanceUpdate(
        order.advertiser.id, "order_cancellation", { orderId: order.id, refundAmount }
      );
    } catch (_) { /* best-effort */ }

    return refundAmount;
  },

  // Cancellation Helper: Create audit log
  // Audit M7 fix — atomic cancel. Wraps the entire cancellation critical
  // section (row lock → idempotency check → refund → status flip) inside a
  // single transaction. Used by:
  //   - controllers.cancelOrder (user-initiated cancel from advertiser/publisher/admin)
  //   - cron/order-cancellation (auto-cancel of stale pending/accepted orders)
  // The SELECT ... FOR UPDATE lock serializes concurrent attempts; the
  // pre-state check makes the operation idempotent (a retry against an
  // already-cancelled order is a no-op, not a double refund).
  async cancelOrderAtomic(orderId, options = {}) {
    const { cancelledBy = 'system', reason = null, notes = null, actorUserId = null } = options;
    return await strapi.db.transaction(async ({ trx }) => {
      // Row-level exclusive lock. Concurrent cancels/rejects/cron runs
      // block here until this commits/rolls back.
      const locked = await trx('orders').where({ id: orderId }).forUpdate().select('id', 'order_status');
      if (!locked || locked.length === 0) {
        throw new Error('Order not found');
      }
      const currentStatus = locked[0].order_status;

      // Idempotency. If the order has already moved to a terminal state,
      // do NOT refund again. Return a sentinel so the caller can choose to
      // ignore (cron) or surface as a 4xx (controller).
      const TERMINAL = ['cancelled', 'rejected', 'refunded', 'completed'];
      if (TERMINAL.includes(currentStatus)) {
        return { alreadyTerminal: true, currentStatus };
      }

      // Re-fetch order with relations under the lock.
      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['advertiser', 'publisher', 'website'],
      });
      if (!order) throw new Error('Order not found');

      // Refund escrow. Throws if already refunded (defense-in-depth) or
      // if escrow drained — both of which indicate a prior partial commit.
      const refundAmount = await this.refundEscrowToAdvertiser(order);

      // Flip status INSIDE the transaction so a failure rolls back the
      // refund. The locks plus the idempotency pre-check guarantee no
      // concurrent caller can write a competing status here.
      await strapi.db.query('api::order.order').update({
        where: { id: orderId },
        data: {
          orderStatus: 'cancelled',
          cancellationReason: reason,
          cancellationNotes: notes,
          cancelledBy,
          cancelledAt: new Date(),
        },
      });

      // Audit log inside the transaction — links the actor and the action
      // to the same commit boundary as the money movement.
      try {
        await this.createAuditLog(order, 'cancelled', actorUserId, reason);
      } catch (auditErr) {
        // Audit log failure must not orphan a successful cancel. Log and
        // continue — the cancellation is real even if the audit row failed.
        // (createAuditLog itself swallows internal errors, but be defensive.)
        console.error(`[ORDER CANCEL] audit log write failed for order ${orderId}: ${auditErr.message}`);
      }

      return { success: true, refundAmount, refundedTo: 'advertiser', order };
    });
  },

  async createAuditLog(order, action, userId, reason) {
    try {
      await strapi.entityService.create('api::order-audit-log.order-audit-log', {
        data: {
          order: order.id,
          action,
          performedBy: userId, // Can be null for system
          previousStatus: order.orderStatus,
          newStatus: action === 'cancelled' ? 'cancelled' : order.orderStatus,
          reason,
          metadata: {
            orderAmount: order.totalAmount,
            timestamp: new Date().toISOString()
          },
          timestamp: new Date(),
          publishedAt: new Date()
        }
      });
    } catch (e) {
      console.error("Failed to create audit log", e);
    }
  },

  // Cancellation Helper: Send notifications
  async sendCancellationNotifications(order, cancelledBy, reason) {
    const notificationService = strapi.service('api::notification.notification');
    const emailService = strapi.service('api::global.email-operations');

    // Email to advertiser using universal template
    try {
      if (order.advertiser.email) {
        await emailService.sendOrderCancellationEmail(
          order,
          order.advertiser.email,
          cancelledBy,
          reason
        );
        console.log(`Cancellation email sent to advertiser ${order.advertiser.email}`);
      }
    } catch (e) {
      console.error("Failed to send cancellation email to advertiser", e);
    }

    // In-app notification to advertiser
    try {
      await notificationService.createOrderNotification(
        order.id,
        order.publisher ? order.publisher.id : null,
        order.advertiser.id,
        'order_cancelled',
        {
          recipientId: order.advertiser.id,
          cancelledBy,
          reason
        }
      );
    } catch (e) {
      console.error("Failed to create notification for advertiser", e);
    }
  },

  /**
   * Real-time push: emit `order:status_changed` on BOTH parties' channels so
   * advertiser AND publisher dashboards re-render without polling.
   *
   * Best-effort: a WS failure logs a warning but never breaks the underlying
   * status change. Per-user monotonic seq numbers let the client drop
   * out-of-order events.
   *
   * @param {object|number} orderOrId — order entity (preferred — saves a DB
   *   roundtrip) or the order id.
   * @param {string} reason — terse machine tag (e.g. 'accepted', 'delivered',
   *   'completed', 'rejected', 'cancelled', 'disputed', 'revision_requested').
   * @param {object} meta — small payload of context (cancelledBy, deliveryUrl,
   *   etc.). Don't put PII here — it's logged by clients.
   */
  async emitOrderUpdate(orderOrId, reason, meta = {}) {
    try {
      if (!strapi.io || typeof strapi.io.emitToUser !== 'function') return;

      // Resolve the order with both parties + the populate the UI cares about.
      const id = typeof orderOrId === 'object' ? orderOrId.id : orderOrId;
      if (!id) return;
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher'],
      });
      if (!order) return;

      const advertiserId = order.advertiser?.id || null;
      const publisherId = order.publisher?.id || null;
      const occurredAt = new Date().toISOString();

      const basePayload = {
        type: 'order:status_changed',
        orderId: order.id,
        status: order.orderStatus,
        reason,
        websiteUrl: order.websiteUrl || null,
        totalAmount: order.totalAmount != null ? Number(order.totalAmount) : null,
        deliveredDate: order.deliveredDate || null,
        acceptedDate: order.acceptedDate || null,
        occurredAt,
        meta: meta || {},
      };

      const emits = [];
      if (advertiserId) {
        emits.push(strapi.io.emitToUser(advertiserId, 'order:status_changed', {
          ...basePayload,
          side: 'advertiser',
          seq: nextOrderSeq(advertiserId),
        }));
      }
      if (publisherId) {
        emits.push(strapi.io.emitToUser(publisherId, 'order:status_changed', {
          ...basePayload,
          side: 'publisher',
          seq: nextOrderSeq(publisherId),
        }));
      }
      await Promise.all(emits);
    } catch (err) {
      strapi.log?.warn?.(`[Order] emitOrderUpdate failed (non-fatal): ${err.message}`);
    }

    // Email to publisher (if exists) using universal template
    if (order.publisher) {
      try {
        if (order.publisher.email) {
          await emailService.sendOrderCancellationEmail(
            order,
            order.publisher.email,
            cancelledBy,
            reason
          );
          console.log(`Cancellation email sent to publisher ${order.publisher.email}`);
        }
      } catch (e) {
        console.error("Failed to send cancellation email to publisher", e);
      }

      // In-app notification to publisher
      try {
        await notificationService.createOrderNotification(
          order.id,
          order.publisher.id,
          order.advertiser.id,
          'order_cancelled',
          {
            recipientId: order.publisher.id,
            cancelledBy,
            reason
          }
        );
      } catch (e) {
        console.error("Failed to create notification for publisher", e);
      }
    }
  }
}));
