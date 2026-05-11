'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

// Empty core controller — public CRUD is intentionally disabled.
// Admin-facing endpoints live in api/admin/controllers/admin-emails.js
// and operate on this content type via strapi.entityService.
module.exports = createCoreController('api::admin-email.admin-email');
