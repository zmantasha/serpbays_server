'use strict';

/**
 * api-log service
 *
 * Standard core service shim. Reads happen via Strapi's content manager and
 * the custom find/findOne controller actions; writes happen directly via
 * `strapi.db.query('api::api-log.api-log').create(...)` from the Winston
 * StrapiDbTransport, bypassing this service entirely.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::api-log.api-log');
