'use strict';

/**
 * Admin Management Routes
 *
 * All endpoints require super_admin role.
 *
 * Uses Strapi's standard content-API auth (auth: true). After deploying new
 * routes, grant the super_admin role permission for each handler in the
 * Strapi admin panel:
 *   Settings → Users & Permissions Plugin → Roles → super_admin → Permissions
 *   → "Admin" section → check admin-management.{getPageRegistry, listAdmins,
 *      createAdmin, updateAdmin, updateAdminPermissions, deleteAdmin}
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/page-registry',
      handler: 'admin-management.getPageRegistry',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/admins',
      handler: 'admin-management.listAdmins',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/admins',
      handler: 'admin-management.createAdmin',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'PUT',
      path: '/admin/admins/:id',
      handler: 'admin-management.updateAdmin',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'PUT',
      path: '/admin/admins/:id/permissions',
      handler: 'admin-management.updateAdminPermissions',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'DELETE',
      path: '/admin/admins/:id',
      handler: 'admin-management.deleteAdmin',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
