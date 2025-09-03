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
      path: '/api/admin/codes',
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
      path: '/api/admin/codes/stats',
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
      path: '/api/admin/codes/generate',
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
      path: '/api/admin/codes/bulk-generate',
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
      path: '/api/admin/codes/:id/status',
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
      path: '/api/admin/codes/:id',
      handler: 'codes.deleteCode',
      config: {
        auth: false, // Temporarily disable auth for testing
        policies: [],
        middlewares: []
      }
    }
  ]
};
