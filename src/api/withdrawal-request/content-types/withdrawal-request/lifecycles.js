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
          
          // Also update the corresponding transaction status
          console.log(`[Lifecycle] Looking for transaction with withdrawal request #${result.id}...`);
          
          // Try multiple approaches to find the transaction
          let escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
            where: {
              users_permissions_user: withdrawalRequest.publisher.id,
              type: 'escrow_hold',
              transactionStatus: 'pending',
              description: { $contains: `Withdrawal request #${result.id}` }
            }
          });
          
          // If not found, try without pending status filter (in case it was already updated)
          if (!escrowHoldTransaction) {
            console.log(`[Lifecycle] Transaction not found with pending status, trying without status filter...`);
            escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
              where: {
                users_permissions_user: withdrawalRequest.publisher.id,
                type: 'escrow_hold',
                description: { $contains: `Withdrawal request #${result.id}` }
              },
              orderBy: { id: 'desc' }
            });
          }
          
          // If still not found, try with amount matching
          if (!escrowHoldTransaction) {
            console.log(`[Lifecycle] Transaction not found by description, trying by amount and user...`);
            escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
              where: {
                users_permissions_user: withdrawalRequest.publisher.id,
                type: 'escrow_hold',
                amount: withdrawalRequest.amount
              },
              orderBy: { id: 'desc' }
            });
          }
          
          if (escrowHoldTransaction) {
            console.log(`[Lifecycle] Found transaction #${escrowHoldTransaction.id} with status: ${escrowHoldTransaction.transactionStatus}`);
            
            // Only update if not already success
            if (escrowHoldTransaction.transactionStatus !== 'success') {
              await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
                data: {
                  transactionStatus: 'success',
                  description: `${escrowHoldTransaction.description} - Payment completed`
                }
              });
              console.log(`[Lifecycle] ✅ Updated transaction ${escrowHoldTransaction.id} to success`);
            } else {
              console.log(`[Lifecycle] ℹ️ Transaction ${escrowHoldTransaction.id} already marked as success`);
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

      // Refund the amount - add back to wallet balance and deduct from pending withdrawals
      const refundAmount = parseFloat(withdrawalRequest.amount);
      const currentWalletBalance = parseFloat(publisherWallet.balance || 0);
      const currentPendingBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);
      
      const newWalletBalance = currentWalletBalance + refundAmount;
      const newPendingBalance = Math.max(0, currentPendingBalance - refundAmount);
      
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          balance: newWalletBalance,
          pendingWithdrawalBalance: newPendingBalance
        }
      });
      
      console.log(`[Lifecycle] ✅ Refunded withdrawal ${result.id}:`);
      console.log(`   - Wallet balance: ${currentWalletBalance} → ${newWalletBalance} (+$${refundAmount})`);
      console.log(`   - Pending balance: ${currentPendingBalance} → ${newPendingBalance} (-$${refundAmount})`);
      
      // Update the corresponding transaction status to failed
      console.log(`[Lifecycle] Looking for transaction to mark as failed...`);
      
      let escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'escrow_hold',
          description: { $contains: `Withdrawal request #${result.id}` }
        },
        orderBy: { id: 'desc' }
      });
      
      // If not found by description, try by amount
      if (!escrowHoldTransaction) {
        escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: {
            users_permissions_user: withdrawalRequest.publisher.id,
            type: 'escrow_hold',
            amount: withdrawalRequest.amount
          },
          orderBy: { id: 'desc' }
        });
      }
      
      if (escrowHoldTransaction) {
        console.log(`[Lifecycle] Found transaction #${escrowHoldTransaction.id}, updating to failed`);
        
        await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
          data: {
            transactionStatus: 'failed',
            description: `${escrowHoldTransaction.description} - Withdrawal denied`
          }
        });
        console.log(`[Lifecycle] ✅ Updated transaction ${escrowHoldTransaction.id} to failed`);
      } else {
        console.log(`[Lifecycle] ⚠️ No matching transaction found for denied withdrawal #${result.id}`);
      }
      
    } catch (error) {
      console.error(`[Lifecycle] Error handling denied withdrawal ${result.id}:`, error);
    }
}

module.exports = {
  // Lifecycle hook that runs after a withdrawal request is updated
  async afterUpdate(event) {
    const { result, params } = event;
    
    // Handle both paid and denied withdrawal statuses
    if (result.withdrawal_status === 'paid') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} marked as paid - updating pendingWithdrawalBalance`);
      await handlePaidWithdrawal(result);
    } else if (result.withdrawal_status === 'denied') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} marked as denied - refunding to wallet`);
      await handleDeniedWithdrawal(result);
    }
  },
}; 