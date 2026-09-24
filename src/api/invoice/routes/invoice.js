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
    //
    // Fixed 2026-09-24. The scope used to name `invoice.find`, a permission
    // the `authenticated` role does not hold (and must not — core find is
    // not user-scoped, so granting it would expose every customer's
    // invoices). The role DOES hold `invoice.download`, so every customer
    // hitting their own invoice got a 403 "Access Denied" and no PDF.
    // The handler does its own ownership check and 404s on cross-tenant.
    {
      method: 'GET',
      path: '/api/invoices/:id/download',
      handler: 'api::invoice.invoice.download',
      config: {
        auth: {
          scope: ['api::invoice.invoice.download']
        },
        policies: []
      }
    }
  ]
};
