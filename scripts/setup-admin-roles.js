#!/usr/bin/env node

'use strict';

/**
 * Script to create proper admin roles and users for the admin panel
 * Run with: node scripts/setup-admin-roles.js
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

    // Define admin roles with proper hierarchy
    const adminRoles = [
      {
        name: 'Super Admin',
        description: 'Full system access with all permissions',
        type: 'super_admin',
        isAdmin: true,
        level: 1
      },
      {
        name: 'Admin',
        description: 'Administrative access to manage users and content',
        type: 'admin',
        isAdmin: true,
        level: 2
      },
      {
        name: 'Moderator',
        description: 'Limited admin access for content moderation',
        type: 'moderator',
        isAdmin: true,
        level: 3
      }
    ];

    // Create admin roles
    const createdRoles = {};
    for (const roleData of adminRoles) {
      // Check if role already exists
      let existingRole = await app.db.query('plugin::users-permissions.role').findOne({
        where: { type: roleData.type }
      });

      if (!existingRole) {
        // Create the role
        const role = await app.db.query('plugin::users-permissions.role').create({
          data: {
            name: roleData.name,
            description: roleData.description,
            type: roleData.type
          }
        });
        createdRoles[roleData.type] = role;
        console.log(`✅ Created role: ${roleData.name} (${roleData.type})`);
      } else {
        createdRoles[roleData.type] = existingRole;
        console.log(`ℹ️  Role already exists: ${roleData.name} (${roleData.type})`);
      }
    }

    // Create super admin user
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'superadmin@serpbays.com';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin123!';
    
    // Check if super admin already exists
    const existingSuperAdmin = await app.db.query('plugin::users-permissions.user').findOne({
      where: { email: superAdminEmail }
    });

    if (!existingSuperAdmin) {
      // Create super admin user
      const superAdmin = await app.plugins['users-permissions'].services.user.add({
        username: 'superadmin',
        email: superAdminEmail,
        password: superAdminPassword,
        firstName: 'Super',
        lastName: 'Admin',
        confirmed: true,
        blocked: false,
        role: createdRoles.super_admin.id,
        provider: 'local'
      });

      console.log('👑 Super Admin user created successfully!');
      console.log(`📧 Email: ${superAdminEmail}`);
      console.log(`🔑 Password: ${superAdminPassword}`);
      console.log(`🆔 User ID: ${superAdmin.id}`);
      console.log(`🎭 Role: ${createdRoles.super_admin.name}`);

      // Create wallet for super admin
      try {
        await app.controller('api::user-wallet.user-wallet').getOrCreateWallet(superAdmin.id);
        console.log('💰 Super Admin wallet created');
      } catch (walletError) {
        console.log('⚠️  Wallet creation skipped (may already exist)');
      }
    } else {
      console.log('ℹ️  Super Admin user already exists');
    }

    // Create regular admin user
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@serpbays.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
    
    // Check if admin already exists
    const existingAdmin = await app.db.query('plugin::users-permissions.user').findOne({
      where: { email: adminEmail }
    });

    if (!existingAdmin) {
      // Create admin user
      const admin = await app.plugins['users-permissions'].services.user.add({
        username: 'admin',
        email: adminEmail,
        password: adminPassword,
        firstName: 'Admin',
        lastName: 'User',
        confirmed: true,
        blocked: false,
        role: createdRoles.admin.id,
        provider: 'local'
      });

      console.log('👤 Admin user created successfully!');
      console.log(`📧 Email: ${adminEmail}`);
      console.log(`🔑 Password: ${adminPassword}`);
      console.log(`🆔 User ID: ${admin.id}`);
      console.log(`🎭 Role: ${createdRoles.admin.name}`);

      // Create wallet for admin
      try {
        await app.controller('api::user-wallet.user-wallet').getOrCreateWallet(admin.id);
        console.log('💰 Admin wallet created');
      } catch (walletError) {
        console.log('⚠️  Wallet creation skipped (may already exist)');
      }
    } else {
      console.log('ℹ️  Admin user already exists');
    }

    console.log('\n✨ Admin role setup complete!');
    console.log('\n🔐 Admin Credentials:');
    console.log(`Super Admin: ${superAdminEmail} / ${superAdminPassword}`);
    console.log(`Admin: ${adminEmail} / ${adminPassword}`);
    console.log('\n🧪 Test admin login with:');
    console.log('POST http://localhost:1337/api/admin/login');
    console.log(JSON.stringify({
      identifier: adminEmail,
      password: adminPassword
    }, null, 2));

  } catch (error) {
    console.error('❌ Error setting up admin roles:', error);
    process.exit(1);
  }

  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = main;
