'use strict';

/**
 * custom shortlist router
 */

module.exports = {
  routes: [
    {
      method: 'DELETE',
      path: '/shortlists/:id',
      handler: 'shortlist.delete',
    },
  ],
}; 
 