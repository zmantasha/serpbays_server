'use strict';

/**
 * invoice router
 */

module.exports = {
  routes: [
    // Core routes with proper auth configuration
    {
      method: 'GET',
      path: '/api/invoices',
      handler: 'api::invoice.invoice.find',
      config: {
        auth: {
          scope: ['api::invoice.invoice.find']
        },
        policies: []
      }
    },
    {
      method: 'GET',
      path: '/api/invoices/:id',
      handler: 'api::invoice.invoice.findOne',
      config: {
        auth: {
          scope: ['api::invoice.invoice.findOne']
        },
        policies: []
      }
    },
    {
      method: 'POST',
      path: '/api/invoices',
      handler: 'api::invoice.invoice.create',
      config: {
        auth: {
          scope: ['api::invoice.invoice.create']
        },
        policies: []
      }
    },
    {
      method: 'PUT',
      path: '/api/invoices/:id',
      handler: 'api::invoice.invoice.update',
      config: {
        auth: {
          scope: ['api::invoice.invoice.update']
        },
        policies: []
      }
    },
    {
      method: 'DELETE',
      path: '/api/invoices/:id',
      handler: 'api::invoice.invoice.delete',
      config: {
        auth: {
          scope: ['api::invoice.invoice.delete']
        },
        policies: []
      }
    },
    // Custom download route
    {
      method: 'GET',
      path: '/api/invoices/:id/download',
      handler: 'api::invoice.invoice.download',
      config: {
        auth: {
          scope: ['api::invoice.invoice.find']
        },
        policies: []
      }
    }
  ]
};
