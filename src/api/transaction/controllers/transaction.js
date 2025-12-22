'use strict';

/**
 * transaction controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const exchangeRateService = require('../../payment-gateways/services/exchange-rate');

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  // Create payment intent
  async createPayment(ctx) {
    try {
      const { amount, baseAmount, currency = 'USD', gateway } = ctx.request.body;
      const userId = ctx.state?.user?.id;
      let wallet;
      console.log("[PAYMENT] Received payment request:", {
        amount: amount,
        baseAmount: baseAmount,
        currency: currency,
        gateway: gateway,
        amountType: typeof amount,
        baseAmountType: typeof baseAmount
      })
      // Validate required fields
      if (!amount || !gateway) {
        return ctx.badRequest('Amount and gateway are required');
      }

      // Parse amount to float and validate
      const parsedAmount = parseFloat(amount);
      const parsedBaseAmount = baseAmount ? parseFloat(baseAmount) : parsedAmount; // Use baseAmount if provided, otherwise use total amount
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      // Maximum transaction amount check (security measure)
      const MAX_TRANSACTION_AMOUNT = 10000; // $10,000 USD
      if (parsedAmount > MAX_TRANSACTION_AMOUNT) {
        console.warn(`[PAYMENT SECURITY] Transaction amount ${parsedAmount} exceeds maximum ${MAX_TRANSACTION_AMOUNT}`);
        return ctx.badRequest(`Maximum transaction amount is $${MAX_TRANSACTION_AMOUNT.toLocaleString()}`);
      }

      // For development mode without authentication
      if (!userId && process.env.NODE_ENV !== 'production') {
        // Find an existing wallet - any wallet works since they're unified
        wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({});

        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }
      } else if (!userId) {
        return ctx.unauthorized('You must be logged in');
      } else {
        // Find user's wallet
        wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { users_permissions_user: userId }
        });

        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }
      }

      // Double check that we have a valid wallet
      if (!wallet || !wallet.id) {
        return ctx.notFound('Wallet not found');
      }
      console.log("wallet", wallet)

      let paymentData;
      try {
        switch (gateway.toLowerCase()) {
          case 'stripe':
            // Create metadata for the payment intent (include baseAmount for wallet credit)
            const stripeMetadata = {
              walletId: wallet.id.toString(),
              userId: userId ? userId.toString() : 'demo',
              email: wallet.users_permissions_user?.email || 'no-email',
              username: wallet.users_permissions_user?.username || 'unknown',
              baseAmount: parsedBaseAmount.toString(), // Store base amount to credit to wallet
              totalAmount: parsedAmount.toString() // Store total amount paid
            };

            // Use the enhanced payment service with metadata
            console.log('[STRIPE] Creating payment intent with:', {
              totalAmount: parsedAmount,
              baseAmount: parsedBaseAmount,
              currency: currency,
              metadata: stripeMetadata
            });

            paymentData = await strapi.service('api::transaction.payment').createStripePaymentIntent(
              parsedAmount, // Use total amount (with fees) for payment
              currency,
              stripeMetadata
            );

            console.log('[STRIPE] Payment intent created:', {
              id: paymentData.id,
              amount: paymentData.amount,
              currency: paymentData.currency
            });
            break;
          case 'razorpay':
            // Convert USD to INR for Razorpay (Razorpay requires INR)
            let razorpayAmountINR = parsedAmount;
            let razorpayConversionRate = 1;

            if (currency.toUpperCase() === 'USD') {
              try {
                razorpayConversionRate = await exchangeRateService.getExchangeRate('USD', 'INR');
                razorpayAmountINR = parsedAmount * razorpayConversionRate;
                console.log(`[RAZORPAY] Converting USD to INR: $${parsedAmount} × ${razorpayConversionRate} = ₹${razorpayAmountINR.toFixed(2)}`);
              } catch (err) {
                console.error('[RAZORPAY] Failed to get exchange rate, using fallback:', err.message);
                razorpayConversionRate = parseFloat(process.env.USD_TO_INR_RATE || '83.25');
                razorpayAmountINR = parsedAmount * razorpayConversionRate;
              }
            }

            // Create Razorpay order in INR
            paymentData = await strapi.service('api::transaction.payment').createRazorpayOrder(razorpayAmountINR, 'INR');

            // Store conversion info in paymentData for reference
            paymentData.originalAmountUSD = parsedAmount;
            paymentData.conversionRate = razorpayConversionRate;
            paymentData.amountINR = razorpayAmountINR;
            break;
          case 'paypal':
            paymentData = await strapi.service('api::transaction.payment').createPayPalOrder(parsedAmount, currency, {
              walletId: wallet.id,
              userId: userId,
              baseAmount: parsedBaseAmount // Store baseAmount for webhook to use
            });
            break;
          case 'phonepe':
            paymentData = await strapi.service('api::transaction.payment').createPhonePeTransaction(parsedAmount, currency, {
              walletId: wallet.id,
              userId: userId,
              redirectUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/wallet?phonepe_return=true`,
              mobileNumber: '' // Optional: can be passed from client
            });
            break;
          default:
            return ctx.badRequest('Invalid payment gateway');
        }

        if (!paymentData) {
          throw new Error('Failed to create payment data');
        }

        // For Stripe, create transaction record upfront with baseAmount (webhook will update it)
        if (gateway.toLowerCase() === 'stripe') {
          // Create pending transaction with baseAmount (amount to credit to wallet)
          const transaction = await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'deposit',
              amount: parsedBaseAmount, // Store base amount (amount to credit to wallet)
              netAmount: parsedBaseAmount,
              currency: currency.toUpperCase(),
              gateway: 'stripe',
              gatewayTransactionId: paymentData.id,
              transactionStatus: 'pending',
              user_wallet: wallet.id,
              users_permissions_user: userId || wallet.users_permissions_user?.id,
              fund_source: 'main_fund',
              metadata: {
                paymentIntent: paymentData,
                walletId: wallet.id,
                userId: userId || wallet.users_permissions_user?.id,
                baseAmount: parsedBaseAmount, // Store for reference
                totalAmount: parsedAmount, // Store total paid for reference
                createdAt: new Date().toISOString()
              },
              publishedAt: new Date()
            },
            populate: ['user_wallet']
          });

          console.log(`[PAYMENT] ✅ Created pending transaction ${transaction.id} for Payment Intent ${paymentData.id} (Base: $${parsedBaseAmount}, Total: $${parsedAmount})`);

          return {
            data: {
              walletId: wallet.id,
              paymentData: paymentData
            }
          };
        }

        // For PayPal, don't create a transaction yet (handled by webhooks)
        if (gateway.toLowerCase() === 'paypal') {
          return {
            data: {
              walletId: wallet.id,
              paymentData: paymentData
            }
          };
        }

        // For PhonePe, return redirect URL
        if (gateway.toLowerCase() === 'phonepe') {
          // Create pending transaction for PhonePe
          const transaction = await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'deposit',
              amount: parsedAmount,
              netAmount: parsedAmount,
              currency: currency,
              gateway: gateway,
              gatewayTransactionId: paymentData.transactionId,
              transactionStatus: 'pending',
              user_wallet: wallet.id,
              users_permissions_user: userId || wallet.users_permissions_user,
              metadata: {
                phonepeData: paymentData,
                walletId: wallet.id,
                userId: userId
              },
              publishedAt: new Date()
            },
            populate: ['user_wallet']
          });

          console.log(`✅ Created PhonePe transaction ${transaction.id} for ${parsedAmount} ${currency}`);

          return {
            data: {
              transaction: transaction,
              walletId: wallet.id,
              paymentData: paymentData,
              redirectUrl: paymentData.redirectUrl // PhonePe checkout URL
            }
          };
        }

        // For Razorpay, create a pending transaction
        // Store the base USD amount (what user will get in wallet), but record INR payment details
        const razorpayBaseAmount = gateway.toLowerCase() === 'razorpay' ? parsedBaseAmount : parsedAmount;
        const razorpayINRAmount = paymentData.amountINR || parsedAmount;
        const razorpayRate = paymentData.conversionRate || 1;

        const transaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'deposit',
            amount: razorpayBaseAmount, // Store USD amount (what will be credited to wallet)
            netAmount: razorpayBaseAmount,
            currency: 'USD', // Wallet is in USD
            gateway: gateway,
            gatewayTransactionId: paymentData.id,
            transactionStatus: 'pending',
            user_wallet: wallet.id,
            users_permissions_user: userId || wallet.users_permissions_user,
            metadata: {
              paymentData: paymentData,
              walletId: wallet.id,
              userId: userId,
              baseAmountUSD: razorpayBaseAmount,
              paidAmountINR: razorpayINRAmount,
              conversionRate: razorpayRate,
              originalAmountUSD: paymentData.originalAmountUSD || parsedAmount
            },
            publishedAt: new Date()
          },
          populate: ['user_wallet']
        });

        console.log(`[RAZORPAY] ✅ Created pending transaction ${transaction.id}: Base USD $${razorpayBaseAmount}, Paid INR ₹${razorpayINRAmount.toFixed(2)} (Rate: ${razorpayRate})`);

        return { data: { transaction, paymentData } };
      } catch (error) {
        console.error("Payment gateway error:", error);
        return ctx.badRequest(error.message || 'Failed to process payment request');
      }
    } catch (error) {
      console.error("Payment creation error:", error);
      return ctx.badRequest(error.message || 'Failed to create payment');
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

          if (!stripeSignature) {
            console.error('[STRIPE WEBHOOK] ❌ Missing stripe-signature header');
            return ctx.badRequest('Missing Stripe signature header');
          }

          // Verify webhook signature - MANDATORY in all environments
          const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
          if (!webhookSecret) {
            console.error('[STRIPE WEBHOOK] ❌ CRITICAL: STRIPE_WEBHOOK_SECRET not configured');
            return ctx.internalServerError('Webhook signature verification failed - missing secret');
          }

          // Get raw body for signature verification
          const rawBody = ctx.request.body[Symbol.for('unparsedBody')] ||
            ctx.request.body._unparsedBody ||
            ctx.request.rawBody ||
            payload;

          if (!rawBody) {
            console.error('[STRIPE WEBHOOK] ❌ No raw body available for signature verification');
            return ctx.badRequest('Raw body required for webhook verification');
          }

          let event;
          try {
            // Verify signature using Stripe SDK
            event = stripe.webhooks.constructEvent(
              rawBody,
              stripeSignature,
              webhookSecret
            );
            console.log('[STRIPE WEBHOOK] ✅ Signature verified successfully');
          } catch (err) {
            console.error('[STRIPE WEBHOOK] ❌ Signature verification failed:', err.message);
            return ctx.forbidden('Invalid webhook signature');
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
                // Update wallet balance directly (don't create new transaction since we already have one)
                const currentMainBalance = parseFloat(wallet.mainBalance || 0);
                const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
                const newMainBalance = currentMainBalance + transactionAmount;
                const newTotalBalance = newMainBalance + currentPromoBalance;

                await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
                  data: {
                    mainBalance: newMainBalance,
                    balance: newTotalBalance
                  }
                });

                console.log(`✅ Wallet balance updated successfully: Main=${newMainBalance}, Total=${newTotalBalance}`);

                // Update the transaction to link it to the wallet and set fund_source
                await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
                  data: {
                    user_wallet: wallet.id,
                    fund_source: 'main_fund' // Direct payments go to main balance
                  }
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
          fund_source: 'main_fund', // Direct payments go to main balance
          user_wallet: walletId,
          users_permissions_user: userId || wallet.users_permissions_user,
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
  },

  // Get transaction status
  async getTransactionStatus(ctx) {
    try {
      const { id } = ctx.params;

      // First try to find by gateway transaction ID (payment intent ID)
      let transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: id },
        populate: ['user_wallet', 'invoice']
      });

      if (!transaction) {
        // If not found, try to find by internal transaction ID
        transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { id },
          populate: ['user_wallet', 'invoice']
        });
      }

      if (!transaction) {
        // If still not found, check Stripe directly
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(id);
          return {
            data: {
              transactionStatus: paymentIntent.status === 'succeeded' ? 'success' :
                paymentIntent.status === 'processing' ? 'pending' : 'failed',
              description: `Payment ${paymentIntent.status}`,
              stripeStatus: paymentIntent.status
            }
          };
        } catch (stripeError) {
          console.error('Error checking Stripe payment intent:', stripeError);
          return ctx.notFound('Transaction not found');
        }
      }

      return {
        data: {
          id: transaction.id,
          type: transaction.type,
          amount: transaction.amount,
          currency: transaction.currency,
          transactionStatus: transaction.transactionStatus,
          description: transaction.description,
          invoice: transaction.invoice ? {
            id: transaction.invoice.id,
            invoiceNumber: transaction.invoice.invoiceNumber,
            pdfUrl: transaction.invoice.pdfUrl
          } : null
        }
      };
    } catch (error) {
      console.error('Error getting transaction status:', error);
      return ctx.badRequest('Failed to get transaction status');
    }
  },

  // Manual PayPal payment verification (fallback if webhook fails)
  async verifyPayPalPayment(ctx) {
    try {
      const { orderId, walletId } = ctx.request.body;

      if (!orderId || !walletId) {
        return ctx.badRequest('Order ID and Wallet ID are required');
      }

      console.log(`[MANUAL PAYPAL VERIFY] Checking PayPal order: ${orderId} for wallet: ${walletId}`);

      // Get PayPal order details
      const orderDetails = await strapi.service('api::transaction.payment').getPayPalOrderDetails(orderId);

      if (!orderDetails.success) {
        return ctx.badRequest('Failed to get PayPal order details');
      }

      const order = orderDetails.order;

      // Check if order is completed
      if (order.status !== 'COMPLETED') {
        return ctx.badRequest('PayPal order is not completed');
      }

      const purchaseUnit = order.purchase_units[0];
      const amount = parseFloat(purchaseUnit.amount.value);

      // Check if transaction already exists
      const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          gatewayTransactionId: orderId,
          user_wallet: walletId
        }
      });

      if (existingTransaction) {
        return ctx.send({
          success: true,
          message: 'Transaction already processed',
          transaction: existingTransaction
        });
      }

      // Find the wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId }
      });

      if (!wallet) {
        return ctx.badRequest('Wallet not found');
      }

      // Update wallet balance
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const newMainBalance = currentMainBalance + amount;
      const newTotalBalance = newMainBalance + currentPromoBalance;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: walletId },
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });

      // Create transaction record
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          transactionStatus: 'success',
          gateway: 'paypal',
          gatewayTransactionId: orderId,
          description: `PayPal payment - Manual verification`,
          user_wallet: walletId,
          users_permissions_user: wallet.users_permissions_user,
          fund_source: 'main_fund',
          fee: 0,
          metadata: {
            orderId: orderId,
            manualVerification: true
          },
          publishedAt: new Date()
        }
      });

      console.log(`[MANUAL PAYPAL VERIFY] ✅ Payment processed successfully - Wallet ${walletId} updated with $${amount}`);

      return ctx.send({
        success: true,
        message: 'Payment verified and wallet updated',
        transaction: transaction,
        newBalance: newTotalBalance
      });

    } catch (error) {
      console.error('[MANUAL PAYPAL VERIFY ERROR]', error);
      return ctx.internalServerError('Failed to verify PayPal payment');
    }
  },

  // Approve transaction via email (Admin only)
  async approveTransaction(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = (user.role && (user.role.type === 'admin' || user.role.name === 'Admin')) || user.email === 'mantasha@wordscloud.in';

      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'success',
          approvedAt: new Date(),
          approvedBy: user.id
        }
      });

      // Send approval email
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendTransactionApprovalEmail(
          updatedTransaction,
          transaction.users_permissions_user.email
        );
        console.log(`Transaction approval email sent for transaction ${id}`);
      } catch (emailError) {
        console.error('Failed to send transaction approval email:', emailError);
        // Don't fail the approval if email fails
      }

      return {
        data: updatedTransaction,
        meta: {
          message: 'Transaction approved successfully and email sent'
        }
      };
    } catch (error) {
      console.error('Error approving transaction:', error);
      return ctx.internalServerError('An error occurred while approving the transaction');
    }
  },

  // Deny transaction via email (Admin only)
  async denyTransaction(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = (user.role && (user.role.type === 'admin' || user.role.name === 'Admin')) || user.email === 'mantasha@wordscloud.in';

      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      if (!reason || reason.trim().length === 0) {
        return ctx.badRequest('Denial reason is required');
      }

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'denied',
          deniedAt: new Date(),
          deniedBy: user.id,
          denialReason: reason.trim()
        }
      });

      // Send denial email
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendTransactionDenialEmail(
          updatedTransaction,
          transaction.users_permissions_user.email,
          reason.trim()
        );
        console.log(`Transaction denial email sent for transaction ${id}`);
      } catch (emailError) {
        console.error('Failed to send transaction denial email:', emailError);
        // Don't fail the denial if email fails
      }

      return {
        data: updatedTransaction,
        meta: {
          message: 'Transaction denied successfully and email sent'
        }
      };
    } catch (error) {
      console.error('Error denying transaction:', error);
      return ctx.internalServerError('An error occurred while denying the transaction');
    }
  },

  // Mark transaction as paid via email (Admin only)
  async markTransactionPaid(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = (user.role && (user.role.type === 'admin' || user.role.name === 'Admin')) || user.email === 'mantasha@wordscloud.in';

      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'paid',
          paidAt: new Date(),
          markedPaidBy: user.id
        }
      });

      // Send payment confirmation email
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendPaymentConfirmationEmail(
          updatedTransaction,
          transaction.users_permissions_user.email
        );
        console.log(`Payment confirmation email sent for transaction ${id}`);
      } catch (emailError) {
        console.error('Failed to send payment confirmation email:', emailError);
        // Don't fail the operation if email fails
      }

      return {
        data: updatedTransaction,
        meta: {
          message: 'Transaction marked as paid successfully and email sent'
        }
      };
    } catch (error) {
      console.error('Error marking transaction as paid:', error);
      return ctx.internalServerError('An error occurred while marking the transaction as paid');
    }
  }
}));
