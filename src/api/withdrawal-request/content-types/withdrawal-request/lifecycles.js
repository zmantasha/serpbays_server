'use strict';

// Handle paid withdrawal
async function handlePaidWithdrawal(result) {

  try {
    // Get the withdrawal request with publisher details
    const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', result.id, {
      populate: ['publisher']
    });

    if (!withdrawalRequest || !withdrawalRequest.publisher) {
      console.error(`[Lifecycle] Publisher not found for withdrawal request ${result.id}`);
      return;
    }

    // Get publisher wallet
    const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: {
        users_permissions_user: withdrawalRequest.publisher.id
      }
    });

    if (!publisherWallet) {
      console.error(`[Lifecycle] Publisher wallet not found for user ${withdrawalRequest.publisher.id}`);
      return;
    }

    // Check if this withdrawal amount should be deducted from pendingWithdrawalBalance
    const amountToDeduct = parseFloat(withdrawalRequest.amount);
    const currentPendingBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);

    if (currentPendingBalance >= amountToDeduct) {
      // Update pendingWithdrawalBalance
      const newPendingBalance = Math.max(0, currentPendingBalance - amountToDeduct);

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          pendingWithdrawalBalance: newPendingBalance
        }
      });

      console.log(`[Lifecycle] ✅ Updated pendingWithdrawalBalance for withdrawal ${result.id}: ${currentPendingBalance} → ${newPendingBalance}`);

      // Send email notification for withdrawal payment
      /*
      DISABLED: sendWithdrawalStatusEmail function doesn't exist
      try {
        const emailService = strapi.service('api::global.email-operations');
        
        await emailService.sendWithdrawalStatusEmail(
          withdrawalRequest,
          withdrawalRequest.publisher.email,
          'paid'
        );
        
        console.log(`[Lifecycle] ✅ Withdrawal paid email sent for withdrawal ${result.id}`);
      } catch (emailError) {
        console.error(`[Lifecycle] ❌ Failed to send withdrawal paid email:`, emailError);
      }
      */

      // Update the corresponding transaction status (only if not already updated by admin)
      console.log(`[Lifecycle] Looking for transaction with withdrawal request #${result.id}...`);

      // Try multiple approaches to find the transaction
      let escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'withdrawal',
          description: { $contains: `Withdrawal request #${result.id}` }
        },
        orderBy: { id: 'desc' }
      });

      // If not found, try with amount matching as fallback
      if (!escrowHoldTransaction) {
        console.log(`[Lifecycle] Transaction not found by description, trying by amount and user...`);
        escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: {
            users_permissions_user: withdrawalRequest.publisher.id,
            type: 'withdrawal',
            amount: withdrawalRequest.amount
          },
          orderBy: { id: 'desc' }
        });
      }

      if (escrowHoldTransaction) {
        console.log(`[Lifecycle] Found transaction #${escrowHoldTransaction.id} with status: ${escrowHoldTransaction.transactionStatus}`);

        // Only update if not already paid (prevent duplicate updates)
        if (escrowHoldTransaction.transactionStatus !== 'paid') {
          // Prepare update data
          const updateData = {
            transactionStatus: 'paid',
            description: `${escrowHoldTransaction.description} - Payment completed via lifecycle`
          };

          // Add external transaction ID if available (only if not already set)
          if (withdrawalRequest.external_transaction_id && !escrowHoldTransaction.external_transaction_id) {
            updateData.external_transaction_id = withdrawalRequest.external_transaction_id;
          }

          // Add payment notes if available (only if not already set)
          if (withdrawalRequest.payment_notes && !escrowHoldTransaction.payment_notes) {
            updateData.payment_notes = withdrawalRequest.payment_notes;
          }

          await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
            data: updateData
          });
          console.log(`[Lifecycle] ✅ Updated transaction ${escrowHoldTransaction.id} to paid status`);
        } else {
          console.log(`[Lifecycle] ℹ️ Transaction ${escrowHoldTransaction.id} already marked as paid (skipping update)`);
        }
      } else {
        console.log(`[Lifecycle] ⚠️ No matching escrow_hold transaction found for withdrawal #${result.id}`);
      }

    } else {
      console.warn(`[Lifecycle] ⚠️ Cannot deduct ${amountToDeduct} from pendingWithdrawalBalance ${currentPendingBalance} for withdrawal ${result.id}`);
    }

  } catch (error) {
    console.error(`[Lifecycle] Error updating pendingWithdrawalBalance for withdrawal ${result.id}:`, error);
  }
}

// Handle denied withdrawal - refund money back to wallet
async function handleDeniedWithdrawal(result) {
  try {
    // Get the withdrawal request with publisher details
    const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', result.id, {
      populate: ['publisher']
    });

    if (!withdrawalRequest || !withdrawalRequest.publisher) {
      console.error(`[Lifecycle] Publisher not found for withdrawal request ${result.id}`);
      return;
    }

    // Get publisher wallet
    const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: {
        users_permissions_user: withdrawalRequest.publisher.id
      }
    });

    if (!publisherWallet) {
      console.error(`[Lifecycle] Publisher wallet not found for user ${withdrawalRequest.publisher.id}`);
      return;
    }

      // Refund the full amount (withdrawal + 20% platform fee) back to wallet
      const PLATFORM_FEE_RATE = 0.20;
      const withdrawalAmount = parseFloat(withdrawalRequest.amount);
      const platformFee = Math.round((withdrawalAmount / (1 - PLATFORM_FEE_RATE)) * PLATFORM_FEE_RATE * 100) / 100;
      const totalRefund = Math.round((withdrawalAmount + platformFee) * 100) / 100;

      const currentMainBalance = parseFloat(publisherWallet.mainBalance || 0);
      const currentPendingBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);

      const newMainBalance = currentMainBalance + totalRefund;
      const newTotalBalance = newMainBalance + (parseFloat(publisherWallet.promoBalance) || 0);
      const newPendingBalance = Math.max(0, currentPendingBalance - withdrawalAmount);

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance,
          pendingWithdrawalBalance: newPendingBalance
        }
      });

      console.log(`[Lifecycle] ✅ Refunded withdrawal ${result.id}:`);
      console.log(`   - Main balance: ${currentMainBalance} → ${newMainBalance} (+$${totalRefund} = $${withdrawalAmount} payout + $${platformFee} fee)`);
      console.log(`   - Pending balance: ${currentPendingBalance} → ${newPendingBalance} (-$${withdrawalAmount})`);
      
      // Send email notification for withdrawal denial
      try {
        const emailService = strapi.service('api::global.email-operations');
        
        await emailService.sendWithdrawalStatusEmail(
          withdrawalRequest,
          withdrawalRequest.publisher.email,
          'denied',
          withdrawalRequest.denial_reason
        );
        
        console.log(`[Lifecycle] ✅ Withdrawal denial email sent for withdrawal ${result.id}`);
      } catch (emailError) {
        console.error(`[Lifecycle] ❌ Failed to send withdrawal denial email:`, emailError);
      }
      
      // Update the corresponding transaction status to failed
      console.log(`[Lifecycle] Looking for transaction to mark as failed...`);
      
      let escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'withdrawal',
          description: { $contains: `Withdrawal request #${result.id}` }
        },
        orderBy: { id: 'desc' }
      });
      
      // If not found by description, try by amount
      if (!escrowHoldTransaction) {
        escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: {
            users_permissions_user: withdrawalRequest.publisher.id,
            type: 'withdrawal',
            amount: withdrawalRequest.amount
          },
          orderBy: { id: 'desc' }
        });
      }
      
      if (escrowHoldTransaction) {
        console.log(`[Lifecycle] Found transaction #${escrowHoldTransaction.id}, updating to failed`);
        
        // Prepare update data for failed transaction
        const updateData = {
          transactionStatus: 'denied',
          description: `${escrowHoldTransaction.description} - Withdrawal denied`
        };

        // Add denial reason if available
        if (withdrawalRequest.denial_reason) {
          updateData.denial_reason = withdrawalRequest.denial_reason;
        }
        
        await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
          data: updateData
        });
        console.log(`[Lifecycle] ✅ Updated transaction ${escrowHoldTransaction.id} to failed with denial reason: ${withdrawalRequest.denial_reason || 'none'}`);
      } else {
        console.log(`[Lifecycle] ⚠️ No matching transaction found for denied withdrawal #${result.id}`);
      }
      
      // Create a separate refund transaction for better visibility
      try {
        const refundTransaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            users_permissions_user: withdrawalRequest.publisher.id,
            type: 'refund',
            amount: Math.abs(totalRefund), // Full refund including platform fee
            netAmount: Math.abs(totalRefund),
            transactionStatus: 'refunded',
            description: `Refund for denied withdrawal request #${result.id} ($${withdrawalAmount} payout + $${platformFee} platform fee)`,
            gateway: 'system',
            gatewayTransactionId: `REFUND_WR_${result.id}_${Date.now()}`,
            user_wallet: publisherWallet.id,
            fee: 0,
            transactionDate: new Date()
          }
        });

        console.log(`[Lifecycle] ✅ Created refund transaction #${refundTransaction.id} for +$${totalRefund}`);
      } catch (refundError) {
        console.error(`[Lifecycle] ❌ Failed to create refund transaction:`, refundError);
      }
      
    } catch (error) {
      console.error(`[Lifecycle] Error handling denied withdrawal ${result.id}:`, error);
    }
}

// Handle approved withdrawal (not yet paid)
async function handleApprovedWithdrawal(result) {
  try {
    // Get the withdrawal request with publisher details
    const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', result.id, {
      populate: ['publisher']
    });

    if (!withdrawalRequest || !withdrawalRequest.publisher) {
      console.error(`[Lifecycle] Publisher not found for withdrawal request ${result.id}`);
      return;
    }

    // Send email notification for withdrawal approval
    /*
    DISABLED: sendWithdrawalStatusEmail function doesn't exist
    try {
      const emailService = strapi.service('api::global.email-operations');
      
      await emailService.sendWithdrawalStatusEmail(
        withdrawalRequest,
        withdrawalRequest.publisher.email,
        'approved'
      );
      
      console.log(`[Lifecycle] ✅ Withdrawal approval email sent for withdrawal ${result.id}`);
    } catch (emailError) {
      console.error(`[Lifecycle] ❌ Failed to send withdrawal approval email:`, emailError);
    }
    */

    // Find and update the corresponding transaction to approved status
    let escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: {
        users_permissions_user: withdrawalRequest.publisher.id,
        type: 'withdrawal',
        description: { $contains: `Withdrawal request #${result.id}` }
      },
      orderBy: { id: 'desc' }
    });

    if (escrowHoldTransaction && escrowHoldTransaction.transactionStatus === 'pending') {
      await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
        data: {
          transactionStatus: 'approved',
          description: `${escrowHoldTransaction.description} - Approved by admin`
        }
      });
      console.log(`[Lifecycle] ✅ Updated transaction ${escrowHoldTransaction.id} to approved status`);
    }

  } catch (error) {
    console.error(`[Lifecycle] Error handling approved withdrawal ${result.id}:`, error);
  }
}

// Audit Wave-4 R115 / CMS-status-transition bug — legal transition whitelist.
//
// Pre-fix: afterUpdate fired the destination handler on EVERY update where the
// new status matched, regardless of previous status — so a CMS flip
// denied → approved (no-op on wallet) followed by approved → denied (compound
// refund) over-credited the wallet and corrupted pendingWithdrawalBalance.
// The default Strapi update route and the admin content-manager both bypass
// the controllers' own status guards.
//
// Legal transitions are validated in beforeUpdate. Illegal transitions throw
// a ValidationError, surfaced as a save error in the admin UI. afterUpdate
// dispatches handlers ONLY when status actually changed (transition detected
// in beforeUpdate and stashed on event.state).
const LEGAL_TRANSITIONS = {
  pending: ['approved', 'denied'],
  approved: ['paid', 'denied'],  // approved → denied not used by controller but kept legal for admin-reversal via dedicated endpoint
  denied: [],                    // terminal
  paid: [],                      // terminal
};

module.exports = {
  // Audit Wave-4 — validate status transitions before write. CMS / default
  // update route now blocked from illegal flips.
  async beforeUpdate(event) {
    const { params } = event;
    event.state = event.state || {};
    event.state.statusChanged = false;

    const incomingStatus = params?.data?.withdrawal_status;
    if (incomingStatus === undefined || incomingStatus === null) {
      // Update doesn't touch status. Nothing to validate; nothing to dispatch.
      return;
    }

    const where = params?.where;
    if (!where) {
      // No identifying filter — let the core router error naturally.
      return;
    }

    // Resolve the row(s) being updated. For the common single-id case this is
    // O(1); for bulk updates we validate every matching row.
    const candidates = await strapi.db.query('api::withdrawal-request.withdrawal-request').findMany({
      where,
      select: ['id', 'withdrawal_status'],
    });

    if (!Array.isArray(candidates) || candidates.length === 0) {
      // Row doesn't exist; let the core router 404 it.
      return;
    }

    for (const row of candidates) {
      const previousStatus = row.withdrawal_status;
      if (previousStatus === incomingStatus) continue;

      const allowed = LEGAL_TRANSITIONS[previousStatus] || [];
      if (!allowed.includes(incomingStatus)) {
        const err = new Error(
          `Illegal withdrawal status transition for request #${row.id}: ` +
          `'${previousStatus}' → '${incomingStatus}' is not allowed. ` +
          `From '${previousStatus}', allowed targets: ` +
          `[${allowed.length ? allowed.join(', ') : 'none — terminal state'}]. ` +
          `Use approveWithdrawal / denyWithdrawal / markAsPaidWithdrawal endpoints instead of editing status in CMS.`
        );
        // ValidationError name → Strapi surfaces in admin UI as a friendly toast
        // and HTTP 400 on the API path.
        err.name = 'ValidationError';
        throw err;
      }
      // At least one candidate is a real transition; afterUpdate should dispatch.
      event.state.statusChanged = true;
      event.state.previousStatus = previousStatus;
    }
  },

  // Real-time push on creation so any other open tab / device for the
  // requester sees the new pending request without a refresh.
  async afterCreate(event) {
    try {
      const { result } = event;
      if (!result?.id) return;
      await strapi.service('api::withdrawal-request.withdrawal-request')
        .emitWithdrawalStatusChanged(result, null, { lifecycle: 'afterCreate' });
    } catch (err) {
      strapi.log?.warn?.(`[Withdrawal lifecycle] afterCreate emit failed (non-fatal): ${err.message}`);
    }
  },

  // Lifecycle hook that runs after a withdrawal request is updated.
  async afterUpdate(event) {
    const { result, state } = event;

    // Audit Wave-4 — dispatch handlers ONLY on actual status transitions.
    // Non-status updates (denial_reason edits, payment_notes etc.) no-op.
    if (!state || !state.statusChanged) {
      return;
    }

    if (result.withdrawal_status === 'approved') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} transitioned ${state.previousStatus} → approved`);
      await handleApprovedWithdrawal(result);
    } else if (result.withdrawal_status === 'paid') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} transitioned ${state.previousStatus} → paid - updating pendingWithdrawalBalance`);
      await handlePaidWithdrawal(result);
    } else if (result.withdrawal_status === 'denied') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} transitioned ${state.previousStatus} → denied - refunding to wallet`);
      await handleDeniedWithdrawal(result);
    }

    // Real-time push to the requester. Best-effort — handler itself
    // swallows errors, so a WS failure never breaks the status change.
    try {
      await strapi.service('api::withdrawal-request.withdrawal-request')
        .emitWithdrawalStatusChanged(result, state.previousStatus, { lifecycle: 'afterUpdate' });
    } catch (_) { /* swallowed in the service */ }
  },
};