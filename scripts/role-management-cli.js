#!/usr/bin/env node

'use strict';

/**
 * Role Management CLI Tool
 * Command-line interface for super admins to manage roles
 * 
 * Usage:
 *   node scripts/role-management-cli.js create --name="Content Manager" --type=admin --description="Manages content and users"
 *   node scripts/role-management-cli.js list
 *   node scripts/role-management-cli.js update --id=1 --name="Senior Admin" --description="Updated description"
 *   node scripts/role-management-cli.js delete --id=1
 *   node scripts/role-management-cli.js assign --userId=1 --roleId=2
 *   node scripts/role-management-cli.js remove --userId=1
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

// Create role
async function createRole(app, options) {
  const { name, type, description, permissions } = options;
  
  if (!name || !type) {
    throw new Error('Name and type are required for creating roles');
  }
  
  // Validate role type
  const validTypes = ['super_admin', 'admin', 'moderator', 'custom'];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid role type. Must be one of: ${validTypes.join(', ')}`);
  }
  
  // Check if role already exists
  const existingRole = await app.db.query('plugin::users-permissions.role').findOne({
    where: { 
      $or: [
        { name },
        { type }
      ]
    }
  });
  
  if (existingRole) {
    throw new Error(`Role with name '${name}' or type '${type}' already exists`);
  }
  
  // Parse permissions if provided
  let permissionsArray = [];
  if (permissions) {
    permissionsArray = permissions.split(',').map(p => p.trim());
  }
  
  // Create the role
  const role = await app.db.query('plugin::users-permissions.role').create({
    data: {
      name,
      description: description || `${name} role`,
      type,
      isAdmin: true,
      permissions: permissionsArray
    }
  });
  
  console.log('✅ Role created successfully!');
  console.log(`📝 Name: ${role.name}`);
  console.log(`🎭 Type: ${role.type}`);
  console.log(`📄 Description: ${role.description}`);
  console.log(`🔑 Permissions: ${role.permissions.join(', ') || 'None'}`);
  console.log(`🆔 ID: ${role.id}`);
  
  return role;
}

// List roles
async function listRoles(app) {
  const roles = await app.db.query('plugin::users-permissions.role').findMany({
    where: { isAdmin: true },
    orderBy: { name: 'asc' }
  });
  
  console.log('\n👥 Admin Roles:');
  console.log('================');
  
  if (roles.length === 0) {
    console.log('No admin roles found.');
    return;
  }
  
  for (const role of roles) {
    // Get user count for this role
    const userCount = await app.db.query('plugin::users-permissions.user').count({
      where: { role: role.id }
    });
    
    console.log(`\n📝 ${role.name}`);
    console.log(`   ID: ${role.id}`);
    console.log(`   Type: ${role.type}`);
    console.log(`   Description: ${role.description}`);
    console.log(`   Users: ${userCount}`);
    console.log(`   Permissions: ${role.permissions?.join(', ') || 'None'}`);
    console.log(`   Created: ${new Date(role.createdAt).toLocaleDateString()}`);
  }
  
  console.log(`\nTotal: ${roles.length} admin roles`);
}

// Update role
async function updateRole(app, options) {
  const { id, name, description, permissions } = options;
  
  if (!id) {
    throw new Error('Role ID is required for updating roles');
  }
  
  // Find the role
  const existingRole = await app.db.query('plugin::users-permissions.role').findOne({
    where: { id: parseInt(id) }
  });
  
  if (!existingRole) {
    throw new Error(`Role with ID ${id} not found`);
  }
  
  // Prevent updating system roles
  const systemRoles = ['super_admin', 'admin', 'moderator'];
  if (systemRoles.includes(existingRole.type)) {
    throw new Error('Cannot update system roles');
  }
  
  // Parse permissions if provided
  let permissionsArray = existingRole.permissions || [];
  if (permissions) {
    permissionsArray = permissions.split(',').map(p => p.trim());
  }
  
  // Update the role
  const updatedRole = await app.db.query('plugin::users-permissions.role').update({
    where: { id: parseInt(id) },
    data: {
      name: name || existingRole.name,
      description: description || existingRole.description,
      permissions: permissionsArray
    }
  });
  
  console.log('✅ Role updated successfully!');
  console.log(`📝 Name: ${updatedRole.name}`);
  console.log(`🎭 Type: ${updatedRole.type}`);
  console.log(`📄 Description: ${updatedRole.description}`);
  console.log(`🔑 Permissions: ${updatedRole.permissions.join(', ') || 'None'}`);
  console.log(`🆔 ID: ${updatedRole.id}`);
  
  return updatedRole;
}

// Delete role
async function deleteRole(app, options) {
  const { id } = options;
  
  if (!id) {
    throw new Error('Role ID is required for deleting roles');
  }
  
  // Find the role
  const existingRole = await app.db.query('plugin::users-permissions.role').findOne({
    where: { id: parseInt(id) }
  });
  
  if (!existingRole) {
    throw new Error(`Role with ID ${id} not found`);
  }
  
  // Prevent deleting system roles
  const systemRoles = ['super_admin', 'admin', 'moderator'];
  if (systemRoles.includes(existingRole.type)) {
    throw new Error('Cannot delete system roles');
  }
  
  // Check if any users are assigned to this role
  const usersWithRole = await app.db.query('plugin::users-permissions.user').findMany({
    where: { role: parseInt(id) }
  });
  
  if (usersWithRole.length > 0) {
    throw new Error(`Cannot delete role. ${usersWithRole.length} users are assigned to this role`);
  }
  
  // Delete the role
  await app.db.query('plugin::users-permissions.role').delete({
    where: { id: parseInt(id) }
  });
  
  console.log('✅ Role deleted successfully!');
  console.log(`📝 Deleted: ${existingRole.name} (${existingRole.type})`);
}

// Assign role to user
async function assignRole(app, options) {
  const { userId, roleId } = options;
  
  if (!userId || !roleId) {
    throw new Error('User ID and Role ID are required for assigning roles');
  }
  
  // Find the user
  const user = await app.db.query('plugin::users-permissions.user').findOne({
    where: { id: parseInt(userId) },
    populate: ['role']
  });
  
  if (!user) {
    throw new Error(`User with ID ${userId} not found`);
  }
  
  // Find the role
  const role = await app.db.query('plugin::users-permissions.role').findOne({
    where: { id: parseInt(roleId) }
  });
  
  if (!role) {
    throw new Error(`Role with ID ${roleId} not found`);
  }
  
  // Check if role is an admin role
  if (!role.isAdmin) {
    throw new Error('Can only assign admin roles through this tool');
  }
  
  // Update user's role
  const updatedUser = await app.db.query('plugin::users-permissions.user').update({
    where: { id: parseInt(userId) },
    data: { role: parseInt(roleId) },
    populate: ['role']
  });
  
  console.log('✅ Role assigned successfully!');
  console.log(`👤 User: ${updatedUser.email} (${updatedUser.username})`);
  console.log(`🎭 Role: ${updatedUser.role.name} (${updatedUser.role.type})`);
}

// Remove role from user
async function removeRole(app, options) {
  const { userId } = options;
  
  if (!userId) {
    throw new Error('User ID is required for removing roles');
  }
  
  // Find the user
  const user = await app.db.query('plugin::users-permissions.user').findOne({
    where: { id: parseInt(userId) },
    populate: ['role']
  });
  
  if (!user) {
    throw new Error(`User with ID ${userId} not found`);
  }
  
  // Get the default authenticated role
  const defaultRole = await app.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'authenticated' }
  });
  
  if (!defaultRole) {
    throw new Error('Default authenticated role not found');
  }
  
  // Update user to default role
  const updatedUser = await app.db.query('plugin::users-permissions.user').update({
    where: { id: parseInt(userId) },
    data: { role: defaultRole.id },
    populate: ['role']
  });
  
  console.log('✅ Role removed successfully!');
  console.log(`👤 User: ${updatedUser.email} (${updatedUser.username})`);
  console.log(`🎭 New Role: ${updatedUser.role.name} (${updatedUser.role.type})`);
}

// Main function
async function main() {
  try {
    const { command, options } = parseArgs();
    
    if (!command) {
      console.log('Role Management CLI Tool');
      console.log('========================');
      console.log('');
      console.log('Usage:');
      console.log('  node scripts/role-management-cli.js <command> [options]');
      console.log('');
      console.log('Commands:');
      console.log('  create    Create a new admin role');
      console.log('  list      List all admin roles');
      console.log('  update    Update an admin role');
      console.log('  delete    Delete an admin role');
      console.log('  assign    Assign role to user');
      console.log('  remove    Remove role from user');
      console.log('');
      console.log('Options:');
      console.log('  --name=<name>              Role name');
      console.log('  --type=<type>              Role type (super_admin, admin, moderator, custom)');
      console.log('  --description=<desc>       Role description');
      console.log('  --permissions=<perms>      Comma-separated permissions');
      console.log('  --id=<id>                  Role ID');
      console.log('  --userId=<id>              User ID');
      console.log('  --roleId=<id>              Role ID');
      console.log('');
      console.log('Examples:');
      console.log('  node scripts/role-management-cli.js create --name="Content Manager" --type=admin --description="Manages content"');
      console.log('  node scripts/role-management-cli.js list');
      console.log('  node scripts/role-management-cli.js update --id=1 --name="Senior Admin"');
      console.log('  node scripts/role-management-cli.js assign --userId=1 --roleId=2');
      process.exit(0);
    }
    
    const app = await bootstrapStrapi();
    console.log('🚀 Strapi loaded successfully');
    
    switch (command) {
      case 'create':
        await createRole(app, options);
        break;
      case 'list':
        await listRoles(app);
        break;
      case 'update':
        await updateRole(app, options);
        break;
      case 'delete':
        await deleteRole(app, options);
        break;
      case 'assign':
        await assignRole(app, options);
        break;
      case 'remove':
        await removeRole(app, options);
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
