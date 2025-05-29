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
        auth: true,
        policies: []
      }
    },
    {
      method: 'GET',
      path: '/api/invoices/:id',
      handler: 'api::invoice.invoice.findOne',
      config: {
        auth: true,
        policies: []
      }
    },
    {
      method: 'POST',
      path: '/api/invoices',
      handler: 'api::invoice.invoice.create',
      config: {
        auth: true,
        policies: []
      }
    },
    {
      method: 'PUT',
      path: '/api/invoices/:id',
      handler: 'api::invoice.invoice.update',
      config: {
        auth: true,
        policies: []
      }
    },
    {
      method: 'DELETE',
      path: '/api/invoices/:id',
      handler: 'api::invoice.invoice.delete',
      config: {
        auth: true,
        policies: []
      }
    },
    // Custom download route
    {
      method: 'GET',
      path: '/api/invoices/:id/download',
      handler: 'api::invoice.invoice.download',
      config: {
        auth: true,
        policies: []
      }
    }
  ]
};
