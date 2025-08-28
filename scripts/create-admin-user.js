#!/usr/bin/env node

'use strict';

/**
 * Script to create an admin user for testing the admin panel APIs
 * Run with: node scripts/create-admin-user.js
 */

const fs = require('fs');
const path = require('path');

// Bootstrap Strapi app
async function main() {
  try {
    // Start Strapi programmatically
    const { default: strapi } = await import('@strapi/strapi');
    
    // Build and start Strapi
    const app = strapi({
      dir: path.resolve(__dirname, '..'),
      autoReload: false,
      serveAdminPanel: false
    });
    
    await app.load();

    console.log('🚀 Strapi loaded successfully');

    // Check if admin user already exists
    const existingAdmin = await app.db.query('plugin::users-permissions.user').findOne({
      where: { email: 'admin@serpbays.com' }
    });

    if (existingAdmin) {
      console.log('✅ Admin user already exists:', existingAdmin.email);
      console.log('📧 Email: admin@serpbays.com');
      console.log('🔑 Password: admin123');
      process.exit(0);
    }

    // Get or create admin role
    let adminRole = await app.db.query('plugin::users-permissions.role').findOne({
      where: { name: 'Admin' }
    });

    if (!adminRole) {
      // Create admin role
      adminRole = await app.db.query('plugin::users-permissions.role').create({
        data: {
          name: 'Admin',
          description: 'Admin role with full permissions',
          type: 'admin'
        }
      });
      console.log('🎭 Admin role created');
    }

    // Create admin user
    const adminUser = await app.plugins['users-permissions'].services.user.add({
      username: 'admin',
      email: 'admin@serpbays.com',
      password: 'admin123',
      firstName: 'Admin',
      lastName: 'User',
      confirmed: true,
      blocked: false,
      role: adminRole.id,
      provider: 'local'
    });

    console.log('👑 Admin user created successfully!');
    console.log('📧 Email: admin@serpbays.com');
    console.log('🔑 Password: admin123');
    console.log('🆔 User ID:', adminUser.id);
    console.log('🎭 Role:', adminRole.name);

    // Create wallet for admin user
    try {
      await app.controller('api::user-wallet.user-wallet').getOrCreateWallet(adminUser.id);
      console.log('💰 Admin wallet created');
    } catch (walletError) {
      console.log('⚠️  Wallet creation skipped (may already exist)');
    }

    console.log('\n✨ Setup complete! You can now use these credentials to test the admin panel.');
    console.log('\n🧪 Test the admin login with:');
    console.log('POST http://localhost:1337/api/admin/login');
    console.log(JSON.stringify({
      identifier: 'admin@serpbays.com',
      password: 'admin123'
    }, null, 2));

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    process.exit(1);
  }

  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main();
}
