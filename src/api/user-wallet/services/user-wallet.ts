/**
 * user-wallet service
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::user-wallet.user-wallet', ({ strapi }) => ({
  async createWallet(userId: number, type: string = 'advertiser') {
    // Check if wallet already exists
    const existingWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { user: userId }
    });

    if (existingWallet) {
      return existingWallet;
    }

    // Create new wallet
    return await strapi.entityService.create('api::user-wallet.user-wallet', {
      data: {
        type,
        currency: 'USD',
        balance: 0,
        escrowBalance: 0,
        user: userId,
        publishedAt: new Date()
      }
    });
  },

  async getWallet(userId: number) {
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { user: userId }
    });

    if (!wallet) {
      return this.createWallet(userId);
    }

    return wallet;
  },

  async createTransaction(walletId: number, data: any) {
    return await strapi.entityService.create('api::wallet-transaction.wallet-transaction', {
      data: {
        ...data,
        wallet: walletId,
        status: 'pending',
        publishedAt: new Date()
      }
    });
  },

  async updateWalletBalance(walletId: number, amount: number, type: string) {
    const wallet = await strapi.entityService.findOne('api::user-wallet.user-wallet', walletId);
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    let newBalance = wallet.balance;
    let newEscrowBalance = wallet.escrowBalance;

    switch (type) {
      case 'deposit':
        newBalance += amount;
        break;
      case 'escrow_hold':
        newBalance -= amount;
        newEscrowBalance += amount;
        break;
      case 'escrow_release':
        newEscrowBalance -= amount;
        break;
      case 'fee':
        newBalance -= amount;
        break;
      case 'refund':
        newBalance += amount;
        break;
      case 'payout':
        newBalance -= amount;
        break;
      default:
        throw new Error('Invalid transaction type');
    }

    return await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
      data: {
        balance: newBalance,
        escrowBalance: newEscrowBalance
      }
    });
  },

  async getTransactions(walletId: number, filters: any = {}) {
    return await strapi.db.query('api::wallet-transaction.wallet-transaction').findMany({
      where: {
        wallet: walletId,
        ...filters
      },
      orderBy: { createdAt: 'DESC' }
    });
  }
}));
