'use strict';

module.exports = {
  // Lifecycle hook that runs after a withdrawal request is updated
  async afterUpdate(event) {
    const { result, params } = event;
    
    // Only proceed if withdrawal_status was changed to 'paid'
    if (result.withdrawal_status === 'paid') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} marked as paid - updating pendingWithdrawalBalance`);
      
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
          const escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
            where: {
              users_permissions_user: withdrawalRequest.publisher.id,
              type: 'escrow_hold',
              transactionStatus: 'pending',
              description: { $contains: `Withdrawal request #${result.id}` }
            }
          });
          
          if (escrowHoldTransaction) {
            await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
              data: {
                transactionStatus: 'success',
                description: `${escrowHoldTransaction.description} - Payment completed`
              }
            });
            console.log(`[Lifecycle] ✅ Updated transaction ${escrowHoldTransaction.id} to success`);
          }
          
        } else {
          console.warn(`[Lifecycle] ⚠️ Cannot deduct ${amountToDeduct} from pendingWithdrawalBalance ${currentPendingBalance} for withdrawal ${result.id}`);
        }
        
      } catch (error) {
        console.error(`[Lifecycle] Error updating pendingWithdrawalBalance for withdrawal ${result.id}:`, error);
      }
    }
  },
}; 