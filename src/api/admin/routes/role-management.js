'use strict';

/**
 * Role Management Routes
 * API endpoints for super admins to manage roles
 */

module.exports = {
  routes: [
    // Create new admin role (Super Admin only)
    {
      method: 'POST',
      path: '/api/admin/roles',
      handler: 'role-management.createRole',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    
    // List all admin roles (Super Admin only)
    {
      method: 'GET',
      path: '/api/admin/roles',
      handler: 'role-management.listRoles',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    
    // Update admin role (Super Admin only)
    {
      method: 'PUT',
      path: '/api/admin/roles/:id',
      handler: 'role-management.updateRole',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    
    // Delete admin role (Super Admin only)
    {
      method: 'DELETE',
      path: '/api/admin/roles/:id',
      handler: 'role-management.deleteRole',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    
    // Assign role to user (Super Admin only)
    {
      method: 'POST',
      path: '/api/admin/roles/assign',
      handler: 'role-management.assignRole',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    
    // Remove role from user (Super Admin only)
    {
      method: 'POST',
      path: '/api/admin/roles/remove',
      handler: 'role-management.removeRole',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
