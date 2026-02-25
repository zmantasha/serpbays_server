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
            amount: Math.abs(refundAmount), // Ensure positive amount for refunds
            netAmount: Math.abs(refundAmount), // Ensure positive amount for refunds
            transactionStatus: 'refunded',
            description: `Refund for denied withdrawal request #${result.id}`,
            gateway: 'system',
            gatewayTransactionId: `REFUND_WR_${result.id}_${Date.now()}`,
            user_wallet: publisherWallet.id,
            fee: 0,
            transactionDate: new Date()
          }
        });
        
        console.log(`[Lifecycle] ✅ Created refund transaction #${refundTransaction.id} for +$${refundAmount}`);
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

module.exports = {
  // Lifecycle hook that runs after a withdrawal request is updated
  async afterUpdate(event) {
    const { result, params } = event;
    
    // Handle different withdrawal statuses
    if (result.withdrawal_status === 'approved') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} marked as approved - sending approval email`);
      await handleApprovedWithdrawal(result);
    } else if (result.withdrawal_status === 'paid') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} marked as paid - updating pendingWithdrawalBalance`);
      await handlePaidWithdrawal(result);
    } else if (result.withdrawal_status === 'denied') {
      console.log(`[Lifecycle] Withdrawal request ${result.id} marked as denied - refunding to wallet`);
      await handleDeniedWithdrawal(result);
    }
  },
}; 