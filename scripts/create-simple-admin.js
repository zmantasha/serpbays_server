'use strict';

/**
 * Create a simple admin user for testing
 */
async function createSimpleAdmin() {
  try {
    // Check if admin user already exists
    const existingAdmin = await strapi.query('plugin::users-permissions.user').findOne({
      where: { email: 'admin@serpbays.com' }
    });

    if (existingAdmin) {
      console.log('Admin user already exists');
      return;
    }

    // Create admin user
    const adminUser = await strapi.query('plugin::users-permissions.user').create({
      data: {
        username: 'admin',
        email: 'admin@serpbays.com',
        password: 'admin123',
        confirmed: true,
        blocked: false,
        role: 1 // Admin role
      }
    });

    console.log('Admin user created successfully:', adminUser.id);
  } catch (error) {
    console.error('Error creating admin user:', error);
  }
}

module.exports = createSimpleAdmin;
