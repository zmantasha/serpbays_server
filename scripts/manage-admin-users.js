#!/usr/bin/env node

'use strict';

/**
 * Admin User Management Script
 * Create, update, and manage admin users with proper roles
 * 
 * Usage:
 *   node scripts/manage-admin-users.js create --email=user@example.com --role=admin --password=password123
 *   node scripts/manage-admin-users.js list
 *   node scripts/manage-admin-users.js update --email=user@example.com --role=super_admin
 *   node scripts/manage-admin-users.js delete --email=user@example.com
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = {};
  
  args.slice(1).forEach(arg => {
    if (arg.startsWith('--')) {
      const [key, value] = arg.substring(2).split('=');
      options[key] = value;
    }
  });
  
  return { command, options };
}

// Bootstrap Strapi app
async function bootstrapStrapi() {
  const { default: strapi } = await import('@strapi/strapi');
  
  const app = strapi({
    dir: path.resolve(__dirname, '..'),
    autoReload: false,
    serveAdminPanel: false
  });
  
  await app.load();
  return app;
}

// Get admin role by type
async function getAdminRole(app, roleType) {
  const role = await app.db.query('plugin::users-permissions.role').findOne({
    where: { type: roleType }
  });
  
  if (!role) {
    throw new Error(`Admin role '${roleType}' not found. Please run setup-admin-roles.js first.`);
  }
  
  return role;
}

// Create admin user
async function createAdminUser(app, options) {
  const { email, role: roleType, password, username, firstName, lastName } = options;
  
  if (!email || !roleType || !password) {
    throw new Error('Email, role, and password are required for creating admin users');
  }
  
  // Validate role type
  const validRoles = ['super_admin', 'admin', 'moderator'];
  if (!validRoles.includes(roleType)) {
    throw new Error(`Invalid role type. Must be one of: ${validRoles.join(', ')}`);
  }
  
  // Check if user already exists
  const existingUser = await app.db.query('plugin::users-permissions.user').findOne({
    where: { email }
  });
  
  if (existingUser) {
    throw new Error(`User with email '${email}' already exists`);
  }
  
  // Get the admin role
  const adminRole = await getAdminRole(app, roleType);
  
  // Create the admin user
  const adminUser = await app.plugins['users-permissions'].services.user.add({
    username: username || email.split('@')[0],
    email,
    password,
    firstName: firstName || 'Admin',
    lastName: lastName || 'User',
    confirmed: true,
    blocked: false,
    role: adminRole.id,
    provider: 'local'
  });
  
  // Create wallet for admin user
  try {
    await app.controller('api::user-wallet.user-wallet').getOrCreateWallet(adminUser.id);
    console.log('💰 Admin wallet created');
  } catch (walletError) {
    console.log('⚠️  Wallet creation skipped (may already exist)');
  }
  
  console.log('✅ Admin user created successfully!');
  console.log(`📧 Email: ${email}`);
  console.log(`🔑 Password: ${password}`);
  console.log(`🆔 User ID: ${adminUser.id}`);
  console.log(`🎭 Role: ${adminRole.name} (${adminRole.type})`);
  
  return adminUser;
}

// List admin users
async function listAdminUsers(app) {
  const adminRoles = await app.db.query('plugin::users-permissions.role').findMany({
    where: { type: { $in: ['super_admin', 'admin', 'moderator'] } }
  });
  
  const roleIds = adminRoles.map(role => role.id);
  
  const adminUsers = await app.db.query('plugin::users-permissions.user').findMany({
    where: { role: { $in: roleIds } },
    populate: ['role']
  });
  
  console.log('\n👥 Admin Users:');
  console.log('================');
  
  if (adminUsers.length === 0) {
    console.log('No admin users found.');
    return;
  }
  
  adminUsers.forEach(user => {
    console.log(`\n📧 ${user.email}`);
    console.log(`   ID: ${user.id}`);
    console.log(`   Username: ${user.username}`);
    console.log(`   Name: ${user.firstName} ${user.lastName}`);
    console.log(`   Role: ${user.role.name} (${user.role.type})`);
    console.log(`   Status: ${user.blocked ? '❌ Blocked' : '✅ Active'}`);
    console.log(`   Confirmed: ${user.confirmed ? '✅ Yes' : '❌ No'}`);
    console.log(`   Created: ${new Date(user.createdAt).toLocaleDateString()}`);
  });
  
  console.log(`\nTotal: ${adminUsers.length} admin users`);
}

// Update admin user role
async function updateAdminUser(app, options) {
  const { email, role: newRoleType } = options;
  
  if (!email || !newRoleType) {
    throw new Error('Email and role are required for updating admin users');
  }
  
  // Validate role type
  const validRoles = ['super_admin', 'admin', 'moderator'];
  if (!validRoles.includes(newRoleType)) {
    throw new Error(`Invalid role type. Must be one of: ${validRoles.join(', ')}`);
  }
  
  // Find the user
  const user = await app.db.query('plugin::users-permissions.user').findOne({
    where: { email },
    populate: ['role']
  });
  
  if (!user) {
    throw new Error(`User with email '${email}' not found`);
  }
  
  // Get the new admin role
  const newAdminRole = await getAdminRole(app, newRoleType);
  
  // Update the user's role
  await app.db.query('plugin::users-permissions.user').update({
    where: { id: user.id },
    data: { role: newAdminRole.id }
  });
  
  console.log('✅ Admin user role updated successfully!');
  console.log(`📧 Email: ${email}`);
  console.log(`🎭 New Role: ${newAdminRole.name} (${newAdminRole.type})`);
  console.log(`🔄 Previous Role: ${user.role.name} (${user.role.type})`);
}

// Delete admin user
async function deleteAdminUser(app, options) {
  const { email, confirm } = options;
  
  if (!email) {
    throw new Error('Email is required for deleting admin users');
  }
  
  if (confirm !== 'yes') {
    throw new Error('Please confirm deletion by adding --confirm=yes');
  }
  
  // Find the user
  const user = await app.db.query('plugin::users-permissions.user').findOne({
    where: { email },
    populate: ['role']
  });
  
  if (!user) {
    throw new Error(`User with email '${email}' not found`);
  }
  
  // Delete the user
  await app.db.query('plugin::users-permissions.user').delete({
    where: { id: user.id }
  });
  
  console.log('✅ Admin user deleted successfully!');
  console.log(`📧 Email: ${email}`);
  console.log(`🎭 Role: ${user.role.name} (${user.role.type})`);
}

// Main function
async function main() {
  try {
    const { command, options } = parseArgs();
    
    if (!command) {
      console.log('Admin User Management Script');
      console.log('============================');
      console.log('');
      console.log('Usage:');
      console.log('  node scripts/manage-admin-users.js <command> [options]');
      console.log('');
      console.log('Commands:');
      console.log('  create    Create a new admin user');
      console.log('  list      List all admin users');
      console.log('  update    Update an admin user\'s role');
      console.log('  delete    Delete an admin user');
      console.log('');
      console.log('Options:');
      console.log('  --email=<email>        User email address');
      console.log('  --role=<role>          Role type (super_admin, admin, moderator)');
      console.log('  --password=<password>  User password');
      console.log('  --username=<username>  Username (optional)');
      console.log('  --firstName=<name>     First name (optional)');
      console.log('  --lastName=<name>      Last name (optional)');
      console.log('  --confirm=yes          Confirm deletion');
      console.log('');
      console.log('Examples:');
      console.log('  node scripts/manage-admin-users.js create --email=admin@example.com --role=admin --password=password123');
      console.log('  node scripts/manage-admin-users.js list');
      console.log('  node scripts/manage-admin-users.js update --email=admin@example.com --role=super_admin');
      console.log('  node scripts/manage-admin-users.js delete --email=admin@example.com --confirm=yes');
      process.exit(0);
    }
    
    const app = await bootstrapStrapi();
    console.log('🚀 Strapi loaded successfully');
    
    switch (command) {
      case 'create':
        await createAdminUser(app, options);
        break;
      case 'list':
        await listAdminUsers(app);
        break;
      case 'update':
        await updateAdminUser(app, options);
        break;
      case 'delete':
        await deleteAdminUser(app, options);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
  
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = main;
