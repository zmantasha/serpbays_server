"use strict";
/**
 * transaction router
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = {
    routes: [
        // Default core collection routes with correct API prefix
        {
            method: 'GET',
            path: '/api/transactions',
            handler: 'api::transaction.transaction.find',
            config: {
                policies: [],
            },
        },
        {
            method: 'GET',
            path: '/api/transactions/:id',
            handler: 'api::transaction.transaction.findOne',
            config: {
                policies: [],
            },
        },
        {
            method: 'POST',
            path: '/api/transactions',
            handler: 'api::transaction.transaction.create',
            config: {
                policies: [],
            },
        },
        {
            method: 'PUT',
            path: '/api/transactions/:id',
            handler: 'api::transaction.transaction.update',
            config: {
                policies: [],
            },
        },
        {
            method: 'DELETE',
            path: '/api/transactions/:id',
            handler: 'api::transaction.transaction.delete',
            config: {
                policies: [],
            },
        },
        // Custom wallet transaction routes with correct API prefix and handler
        {
            method: 'GET',
            path: '/api/wallet-transactions',
            handler: 'api::transaction.transaction.find',
            config: {
                policies: [],
            },
        },
        {
            method: 'POST',
            path: '/api/wallet-transactions',
            handler: 'api::transaction.transaction.create',
            config: {
                policies: [],
            },
        },
    ],
};
