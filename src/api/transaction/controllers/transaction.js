'use strict';

/**
 * transaction controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  // Create payment intent
  async createPayment(ctx) {
    try {
      const { amount, currency, gateway } = ctx.request.body;
      const userId = ctx.state?.user?.id;

      // Get user's wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      let paymentData;
      switch (gateway.toLowerCase()) {
        case 'stripe':
          paymentData = await strapi.service('api::transaction.payment').createStripePaymentIntent(amount, currency);
          // Store userId and walletId in metadata for the webhook to use
          if (paymentData && paymentData.id) {
            await stripe.paymentIntents.update(paymentData.id, {
              metadata: { 
                walletId: wallet.id.toString(),
                userId: userId.toString()
              }
            });
          }
          break;
        case 'razorpay':
          paymentData = await strapi.service('api::transaction.payment').createRazorpayOrder(amount, currency);
          break;
        case 'paypal':
          paymentData = await strapi.service('api::transaction.payment').createPayPalOrder(amount, currency);
          break;
        default:
          return ctx.badRequest('Invalid payment gateway');
      }

      // For Stripe and PayPal, don't create a transaction yet - just return payment intent
      // We'll let the client create the transaction when the user submits their card details
      console.log("wallet", wallet.id)
      if (gateway.toLowerCase() === 'stripe' || gateway.toLowerCase() === 'paypal') {
        return { data: { 
          walletId: wallet.id,
          paymentData: paymentData 
        }};
      }
      
      // For other payment methods like Razorpay where the flow is different,
      // create a pending transaction immediately
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          currency: currency,
          gateway: gateway,
          gatewayTransactionId: paymentData.id,
          transactionStatus: 'pending',
          user_wallet: wallet.id,
          metadata: {
            paymentData: paymentData,
            walletId: wallet.id,  // Store the wallet ID in metadata
            userId: userId        // Store the user ID in metadata
          },
          publishedAt: new Date()
        },
        populate: ['user_wallet']
      });

      return { data: { transaction, paymentData } };
    } catch (error) {
      console.error("Payment creation error:", error);
      return ctx.badRequest(error.message);
    }
  },

  // Handle payment webhook
  async handleWebhook(ctx) {
    try {
      const { gateway } = ctx.params;
      const payload = ctx.request.body;
      
      console.log(`📣 RECEIVED ${gateway.toUpperCase()} WEBHOOK:`, JSON.stringify(payload, null, 2));

      let isValid = false;
      let transactionId;
      let walletIdFromMetadata;

      switch (gateway.toLowerCase()) {
        case 'stripe': {
          const stripeSignature = ctx.request.headers['stripe-signature'];
          let event;
          
          if (process.env.NODE_ENV === 'development') {
            // Skip signature verification in development
            event = payload;
          } else {
            // Verify signature in production
            event = stripe.webhooks.constructEvent(
              payload,
              stripeSignature,
              process.env.STRIPE_WEBHOOK_SECRET
            );
          }
          
          if (event.type === 'payment_intent.succeeded') {
            isValid = true;
            transactionId = event.data.object.id;
            
            // Get metadata from the payment intent if available
            if (event.data.object.metadata && event.data.object.metadata.walletId) {
              walletIdFromMetadata = parseInt(event.data.object.metadata.walletId);
              console.log(`Found walletId ${walletIdFromMetadata} in Stripe payment intent metadata`);
            }
            
            if (event.data.object.payment_intent) {
              transactionId = event.data.object.payment_intent;
            }
            console.log(`💰 Stripe payment intent ${transactionId} succeeded`);
          } else if (event.type === 'payment_intent.payment_failed') {
            // Handle payment failure
            transactionId = event.data.object.id;
            console.log(`Stripe payment intent ${transactionId} failed`);
            return { success: true, status: 'failed' };
          }
          break;
        }

        case 'razorpay': {
          const { order_id, payment_id, razorpay_signature } = payload;
          isValid = await strapi.service('api::transaction.payment').verifyRazorpayPayment(
            order_id,
            payment_id,
            razorpay_signature
          );
          transactionId = order_id;
          break;
        }

        case 'paypal': {
          const orderID = payload.resource ? payload.resource.id : payload.id;
          isValid = await strapi.service('api::transaction.payment').capturePayPalPayment(orderID);
          transactionId = orderID;
          break;
        }

        default:
          return ctx.badRequest('Invalid payment gateway');
      }

      if (isValid && transactionId) {
        // Find transaction by gatewayTransactionId
        const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: transactionId },
          populate: ['user_wallet']
        });
        
        if (existingTransaction) {
          console.log(`✅ Found transaction ${existingTransaction.id}, updating status to success`);
          
          // Update transaction status to success
          await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
            data: { transactionStatus: 'success' }
          });
          
          // Try to get walletId from transaction data
          let walletId = existingTransaction.user_wallet?.id;
          
          // If we can't get the walletId directly, try the metadata
          if (!walletId && existingTransaction.metadata && existingTransaction.metadata.walletId) {
            walletId = existingTransaction.metadata.walletId;
            console.log(`Found walletId ${walletId} in transaction metadata`);
          }
          
          // Try the wallet ID from payment intent metadata
          if (!walletId && walletIdFromMetadata) {
            walletId = walletIdFromMetadata;
            console.log(`Using walletId ${walletId} from payment intent metadata`);
          }
          
          // If we have userId in metadata but no wallet, try to find their wallet
          if (!walletId && existingTransaction.metadata && existingTransaction.metadata.userId) {
            const userId = existingTransaction.metadata.userId;
            console.log(`Looking for wallet belonging to user ${userId}`);
            
            const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { users_permissions_user: userId }
            });
            
            if (wallet) {
              walletId = wallet.id;
              console.log(`Found wallet ${walletId} for user ${userId}`);
            }
          }
          
          if (walletId) {
            console.log(`Looking up wallet with ID: ${walletId}`);
            
            // Find the wallet
            const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { id: walletId },
              populate: ['users_permissions_user']
            });
            
            if (wallet) {
              console.log(`Found wallet for user: ${wallet.users_permissions_user?.id}`);
              
              const currentBalance = parseFloat(wallet.balance) || 0;
              const transactionAmount = parseFloat(existingTransaction.amount) || 0;
              const newBalance = currentBalance + transactionAmount;
              
              console.log(`💵 Updating wallet balance: ${currentBalance} + ${transactionAmount} = ${newBalance}`);
              
              try {
                await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
                  data: { balance: newBalance }
                });
                
                console.log(`✅ Wallet balance updated successfully to ${newBalance}`);
                
                // Update the transaction to link it to the wallet for future reference
                await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
                  data: { user_wallet: wallet.id }
                });

                // Create invoice for successful deposit
                if (existingTransaction.type === 'deposit') {
                  console.log('Creating invoice for successful deposit...');
                  try {
                    // Generate invoice number (you might want to use a more sophisticated system)
                    const invoiceNumber = `INV-${Date.now()}-${existingTransaction.id}`;
                    
                    // Log the transaction data for debugging
                    console.log('Transaction data for invoice:', {
                      amount: existingTransaction.amount,
                      currency: existingTransaction.currency,
                      userId: wallet.users_permissions_user.id
                    });

                    // Create the invoice with all required fields
                    const invoice = await strapi.entityService.create('api::invoice.invoice', {
                      data: {
                        invoiceNumber,
                        invoiceDate: new Date(),
                        user: wallet.users_permissions_user.id,
                        transactionId: existingTransaction.id.toString(),
                        billingName: wallet.users_permissions_user.username || 'Customer',
                        billingAddress: 'Address on file', // You should get this from user profile
                        billingCity: 'City',
                        billingCountry: 'Country',
                        billingPincode: '000000', // Add default pincode
                        lineItems: [{
                          description: 'Wallet Deposit',
                          amount: transactionAmount,
                          quantity: 1
                        }],
                        subtotal: transactionAmount,
                        taxAmount: 0,
                        totalAmount: transactionAmount,
                        currency: existingTransaction.currency || 'USD', // Ensure currency is set with fallback
                        status: 'paid',
                        pdfUrl: `/invoices/${invoiceNumber}.pdf`,
                        notes: `Wallet deposit transaction ${existingTransaction.id}`,
                        publishedAt: new Date()
                      }
                    });
                    
                    console.log(`✅ Invoice created successfully: ${invoice.id}`);
                    
                    // Link the invoice to the transaction
                    await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
                      data: {
                        invoice: invoice.id
                      }
                    });
                  } catch (invoiceError) {
                    console.error('Error creating invoice:', invoiceError);
                    // Log more details about the error
                    if (invoiceError.details?.errors) {
                      console.error('Validation errors:', invoiceError.details.errors);
                    }
                  }
                }
              } catch (error) {
                console.error(`Error updating wallet balance:`, error.message);
              }
            } else {
              console.error(`❌ Wallet with ID ${walletId} not found`);
            }
          } else {
            console.error(`❌ Could not determine wallet ID for transaction ${existingTransaction.id}`);
          }
        } else {
          console.log(`⚠️ No transaction found for gatewayTransactionId: ${transactionId}`);
        }
      }

      // Always return success to Stripe
      return { success: true };
    } catch (error) {
      console.error('❌ Webhook error:', error);
      // Still return 200 status to prevent Stripe retries
      return { success: false, error: error.message };
    }
  },

  // Helper method to mark a transaction as failed
  async markTransactionFailed(gatewayTransactionId) {
    try {
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId }
      });
      
      if (transaction) {
        console.log(`Marking transaction ${transaction.id} as failed`);
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'failed'
          }
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error marking transaction as failed:', error);
      return false;
    }
  },

  // Add a new endpoint to create a pending transaction after payment details are entered
  async createPendingTransaction(ctx) {
    try {
      const { amount, currency, gateway, gatewayTransactionId, walletId } = ctx.request.body;
      
      // Validate the wallet belongs to the user
      const userId = ctx.state?.user?.id;
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId, users_permissions_user: userId }
      });
      
      if (!wallet) {
        return ctx.notFound('Wallet not found or does not belong to user');
      }
      
      // Create pending transaction
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          currency: currency,
          gateway: gateway,
          gatewayTransactionId: gatewayTransactionId,
          transactionStatus: 'pending',
          user_wallet: walletId,
          metadata: {
            walletId: walletId,  // Store the wallet ID in metadata
            userId: userId       // Store the user ID in metadata
          },
          publishedAt: new Date()
        }
      });
      
      console.log(`Created pending transaction ${transaction.id} after payment submission`);
      
      return { data: { transaction } };
    } catch (error) {
      console.error("Error creating pending transaction:", error);
      return ctx.badRequest(error.message);
    }
  }
}));
