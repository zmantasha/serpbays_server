module.exports = async ({ strapi }) => {
  try {
    // Check if admin role already exists
    const existingRole = await strapi.query('plugin::users-permissions.role').findOne({
      where: { type: 'admin' },
    });

    if (existingRole) {
      console.log('Admin role already exists');
      return;
    }

    // Create the admin role
    const adminRole = await strapi.query('plugin::users-permissions.role').create({
      data: {
        name: 'Admin',
        description: 'Administrator role with full access',
        type: 'admin',
      },
    });

    console.log('Admin role created successfully:', adminRole);

    // Set up permissions for the admin role
    const permissionsToCreate = [
      // User permissions
      { action: 'plugin::users-permissions.user.create' },
      { action: 'plugin::users-permissions.user.read' },
      { action: 'plugin::users-permissions.user.update' },
      { action: 'plugin::users-permissions.user.delete' },
      // Role permissions
      { action: 'plugin::users-permissions.role.create' },
      { action: 'plugin::users-permissions.role.read' },
      { action: 'plugin::users-permissions.role.update' },
      { action: 'plugin::users-permissions.role.delete' },
      // Content permissions
      { action: 'plugin::content-manager.explorer.create' },
      { action: 'plugin::content-manager.explorer.read' },
      { action: 'plugin::content-manager.explorer.update' },
      { action: 'plugin::content-manager.explorer.delete' },
    ];

    // Create permissions and link them to the admin role
    for (const permission of permissionsToCreate) {
      await strapi.query('plugin::users-permissions.permission').create({
        data: {
          ...permission,
          role: adminRole.id,
        },
      });
    }

    console.log('Admin role permissions set up successfully');
  } catch (error) {
    console.error('Error creating admin role:', error);
    throw error;
  }
}; 