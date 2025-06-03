'use strict';

const createAdminRole = require('../../scripts/create-admin-role');

module.exports = async ({ strapi }) => {
  // Create admin role if it doesn't exist
  await createAdminRole({ strapi });

  // Check if the default roles exist
  const pluginStore = strapi.store({
    environment: '',
    type: 'plugin',
    name: 'users-permissions',
  });

  const roles = await pluginStore.get({ key: 'roles' });
  
  if (!roles) {
    const defaultRoles = {
      authenticated: {
        name: 'Authenticated',
        description: 'Default role given to authenticated user.',
        type: 'authenticated',
      },
      public: {
        name: 'Public',
        description: 'Default role given to unauthenticated user.',
        type: 'public',
      },
    };

    await pluginStore.set({ key: 'roles', value: defaultRoles });
  }

  // Set default permissions
  const permissions = await strapi.query('plugin::users-permissions.permission').findMany();
  
  const publicRole = await strapi.query('plugin::users-permissions.role').findOne({
    where: { type: 'public' }
  });

  if (publicRole) {
    // Enable necessary public routes
    const publicPermissions = permissions.filter(permission => 
      permission.action === 'auth.callback' ||
      permission.action === 'auth.connect' ||
      permission.action === 'auth.register' ||
      permission.action === 'auth.forgotPassword' ||
      permission.action === 'auth.resetPassword' ||
      permission.action === 'auth.sendEmailConfirmation'
    );

    await Promise.all(
      publicPermissions.map(permission =>
        strapi.query('plugin::users-permissions.permission').update({
          where: { id: permission.id },
          data: { enabled: true }
        })
      )
    );
  }
}; 