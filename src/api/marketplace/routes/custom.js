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
    {
      method: 'POST',
      path: '/marketplaces/export-csv',
      handler: 'export-csv.exportSelected',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/marketplaces/export-selected-csv',
      handler: 'export-csv.exportSelected',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/marketplaces/admin-list',
      handler: 'export-csv.adminList',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/marketplaces/export-filtered-csv',
      handler: 'export-csv.exportFiltered',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
