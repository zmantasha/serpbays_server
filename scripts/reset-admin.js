#!/usr/bin/env node

'use strict';

/**
 * Script to reset admin users and enable registration
 * Run with: node scripts/reset-admin.js
 */

const path = require('path');

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

    // Delete all admin users from the admin_user table
    const deletedCount = await app.db.query('admin::user').deleteMany({});
    
    console.log(`🗑️  Deleted ${deletedCount} admin user(s)`);
    console.log('✅ Admin registration is now enabled!');
    console.log('\n📝 You can now register a new admin at:');
    console.log('http://localhost:1337/admin/auth/register-admin');
    console.log('\n⚠️  Make sure to restart your Strapi server after running this script.');

  } catch (error) {
    console.error('❌ Error resetting admin:', error);
    process.exit(1);
  }

  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main();
}
