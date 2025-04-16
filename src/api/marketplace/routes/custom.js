'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/upload-csv',
      handler: 'marketplace.uploadCSV',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
