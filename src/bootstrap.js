'use strict';

module.exports = async ({ strapi }) => {
  // Get the admin role
  let adminRole = await strapi.query('plugin::users-permissions.role').findOne({
    where: { type: 'admin' },
  });

  if (!adminRole) {
    // Create admin role if it doesn't exist
    adminRole = await strapi.query('plugin::users-permissions.role').create({
      data: {
        name: 'Admin',
        description: 'Admin role with full access',
        type: 'admin',
        permissions: {},
      },
    });
  }

  // Get all available permissions
  const permissions = await strapi.query('plugin::users-permissions.permission').findMany();
  
  // Group permissions by plugin
  const permissionsByPlugin = {};
  permissions.forEach((permission) => {
    const [plugin] = permission.action.split('.');
    if (!permissionsByPlugin[plugin]) {
      permissionsByPlugin[plugin] = [];
    }
    permissionsByPlugin[plugin].push(permission);
  });

  // Update permissions for admin role
  const rolePermissions = {};
  
  // Enable all permissions for admin role
  Object.keys(permissionsByPlugin).forEach((plugin) => {
    rolePermissions[plugin] = {
      controllers: {},
    };

    permissionsByPlugin[plugin].forEach((permission) => {
      const [, controller, action] = permission.action.split('.');
      
      if (!rolePermissions[plugin].controllers[controller]) {
        rolePermissions[plugin].controllers[controller] = {};
      }
      
      rolePermissions[plugin].controllers[controller][action] = {
        enabled: true,
      };
    });
  });

  // Update the admin role with all permissions
  await strapi.query('plugin::users-permissions.role').update({
    where: { id: adminRole.id },
    data: {
      permissions: rolePermissions,
    },
  });

  // Log success
  strapi.log.info('Bootstrap script completed: Admin role and permissions configured');
}; 