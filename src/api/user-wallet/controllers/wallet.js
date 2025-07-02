'use strict';

const { sanitize } = require('@strapi/utils');

module.exports = {
  // Get user's wallet balance
  async getWallet(ctx) {
    const { user } = ctx.state;
    
    // For development, handle requests without authentication
    if (!user && process.env.NODE_ENV !== 'production') {
      try {
        // Find a demo wallet
        let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { type: 'advertiser' }
        });

        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }

        return {
          id: wallet.id,
          balance: wallet.balance,
          escrowBalance: wallet.escrowBalance,
          currency: wallet.currency,
          type: wallet.type
        };
      } catch (error) {
        ctx.throw(500, error);
      }
    } else if (!user) {
      return ctx.unauthorized('You must be logged in');
    }

    try {
      // Find user's wallet
      let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { user: user.id },
        populate: ['user']
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      return {
        id: wallet.id,
        balance: wallet.balance,
        escrowBalance: wallet.escrowBalance,
        currency: wallet.currency,
        type: wallet.type
      };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  // Create a new transaction (deposit)
  async createTransaction(ctx) {
    try {
      const { user } = ctx.state;
      const { type, amount, gateway } = ctx.request.body;
      
      console.log('Transaction request received:', { type, amount, gateway });
      
      // Validate input data
      if (!['deposit'].includes(type)) {
        return ctx.badRequest('Invalid transaction type');
      }

      const parsedAmount = parseFloat(amount);
      if (!parsedAmount || parsedAmount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      if (!['stripe', 'paypal', 'razorpay'].includes(gateway)) {
        return ctx.badRequest('Invalid payment gateway');
      }
      
      // For development, handle requests without authentication
      let wallet;
      
      if (!user && process.env.NODE_ENV !== 'production') {
        console.log('Checking for development wallet');
        
        // Find an existing wallet
        wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { type: 'advertiser' }
        });
        
        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }
      } else if (!user) {
        return ctx.unauthorized('You must be logged in');
      } else {
        // Find user's wallet
        wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { user: user.id }
        });
        
        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }
      }

      // Double check that we have a valid wallet
      if (!wallet || !wallet.id) {
        console.error('Invalid wallet object:', wallet);
        return ctx.notFound('Wallet not found');
      }

      console.log('Creating transaction with data:', {
        type,
        amount: parsedAmount,
        gateway,
        walletId: wallet.id
      });

      try {
        // Create transaction with pending status
        const transaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type,
            amount: parsedAmount,
            netAmount: parsedAmount,
            transactionStatus: 'pending',
            gateway,
            user_wallet: wallet.id,
            users_permissions_user: userId,
            publishedAt: new Date()
          },
        });

        console.log('Transaction created with ID:', transaction.id);
        
        // Verify the transaction was created correctly with the wallet
        const createdTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { id: transaction.id },
          populate: ['user_wallet'],
        });
        
        if (!createdTransaction) {
          console.error('Could not find created transaction');
          return ctx.badRequest('Transaction creation failed');
        }
        
        if (!createdTransaction.user_wallet) {
          console.error('Created transaction has no wallet association:', createdTransaction);
          
          // Try to update the transaction with the wallet ID
          await strapi.entityService.update('api::transaction.transaction', transaction.id, {
            data: {
              user_wallet: wallet.id
            }
          });
          
          console.log('Attempted to fix wallet association');
        } else {
          console.log('Transaction created with correct wallet association');
        }

        // Process payment through the selected gateway
        const paymentService = strapi.service('api::user-wallet.payment');
        console.log('Calling payment service for transaction:', transaction.id);
        
        // Make sure we pass the full transaction object
        const paymentData = await paymentService.createPayment({
          ...transaction,
          user_wallet: wallet.id // Ensure this is set
        }, gateway);
        
        console.log('Payment service returned:', paymentData);

        return {
          transaction: {
            id: transaction.id,
            type: transaction.type,
            amount: transaction.amount,
            status: transaction.transactionStatus
          },
          payment: paymentData
        };
      } catch (dbError) {
        console.error('Database error during transaction creation:', dbError);
        return ctx.badRequest('Database error: ' + dbError.message);
      }
    } catch (error) {
      console.error('Transaction creation error:', error);
      return ctx.badRequest(
        error.message || 'An error occurred while processing the transaction'
      );
    }
  },

  // List user's transactions
  async listTransactions(ctx) {
    const { user } = ctx.state;
    
    // For development, handle requests without authentication
    let wallet;
    
    if (!user && process.env.NODE_ENV !== 'production') {
      // Find a demo wallet
      wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { type: 'advertiser' }
      });
      
      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }
    } else if (!user) {
      return ctx.unauthorized('You must be logged in');
    } else {
      // Find user's wallet
      wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { user: user.id }
      });
      
      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }
    }

    try {
      // Get pagination parameters
      const { page = 1, pageSize = 10 } = ctx.query;
      
      // Query transactions
      const [transactions, count] = await strapi.db.query('api::transaction.transaction').findWithCount({
        where: { user_wallet: wallet.id },
        orderBy: { createdAt: 'DESC' },
        limit: parseInt(pageSize),
        offset: (parseInt(page) - 1) * parseInt(pageSize),
      });

      return {
        data: transactions.map(transaction => ({
          id: transaction.id,
          type: transaction.type,
          amount: transaction.amount,
          status: transaction.transactionStatus,
          date: transaction.createdAt,
          gateway: transaction.gateway,
          gatewayTransactionId: transaction.gatewayTransactionId
        })),
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(count / parseInt(pageSize)),
            total: count
          }
        }
      };
    } catch (error) {
      ctx.throw(500, error);
    }
  }
}; 