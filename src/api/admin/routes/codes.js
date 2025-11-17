'use strict';

/**
 * Admin Codes Routes
 * Routes for managing codes from admin panel
 */

module.exports = {
  routes: [
    // Get all codes with filtering and pagination
    {
      method: 'GET',
      path: '/admin/codes',
      handler: 'codes.find',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    },
    
    // Get code statistics
    {
      method: 'GET',
      path: '/admin/codes/stats',
      handler: 'codes.getStats',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    },
    
    // Generate a new code
    {
      method: 'POST',
      path: '/admin/codes/generate',
      handler: 'codes.generateCode',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    },
    
    // Bulk generate codes
    {
      method: 'POST',
      path: '/admin/codes/bulk-generate',
      handler: 'codes.bulkGenerateCodes',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    },
    
    // Update code status
    {
      method: 'PUT',
      path: '/admin/codes/:id/status',
      handler: 'codes.updateStatus',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    },
    
    // Delete a code
    {
      method: 'DELETE',
      path: '/admin/codes/:id',
      handler: 'codes.deleteCode',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    }
  ]
};
