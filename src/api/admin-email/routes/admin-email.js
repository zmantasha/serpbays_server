'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

// Disable all default public routes — admin-emails is only reachable
// through /admin/emails/* (see api/admin/routes/admin-emails.js).
module.exports = createCoreRouter('api::admin-email.admin-email', {
  only: [],
});
