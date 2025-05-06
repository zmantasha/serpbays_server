"use strict";
/**
 * transaction service
 */
Object.defineProperty(exports, "__esModule", { value: true });
var strapi_1 = require("@strapi/strapi");
exports.default = strapi_1.factories.createCoreService('api::transaction.transaction');
