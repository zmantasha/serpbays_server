'use strict';

/**
 * custom shortlist router
 */

module.exports = {
  routes: [
    {
      method: 'DELETE',
      path: '/shortlists/project/:projectId/marketplace/:marketplaceId',
      handler: 'shortlist.deleteByProjectAndMarketplace',
    },
  ],
}; 