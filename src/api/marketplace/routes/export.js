'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/marketplace/export-csv',
      handler: 'export.exportCSV',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
