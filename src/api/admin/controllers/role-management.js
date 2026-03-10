'use strict';

/**
 * Role Management Controller
 * Allows super admins to create, update, and manage admin roles
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('plugin::users-permissions.role', ({ strapi }) => ({

  /**
   * Create a new admin role
   * Only super admins can create roles
   */
  async createRole(ctx) {
    try {
      const { name, description, type, permissions = [] } = ctx.request.body;

      // Validate required fields
      if (!name || !type) {
        return ctx.badRequest('Name and type are required');
      }

      // Validate role type
      const validTypes = ['super_admin', 'admin', 'moderator', 'custom'];
      if (!validTypes.includes(type)) {
        return ctx.badRequest(`Invalid role type. Must be one of: ${validTypes.join(', ')}`);
      }

      // Check if role already exists
      const existingRole = await strapi.db.query('plugin::users-permissions.role').findOne({
        where: { 
          $or: [
            { name },
            { type }
          ]
        }
      });

      if (existingRole) {
        return ctx.badRequest(`Role with name '${name}' or type '${type}' already exists`);
      }

      // Create the role
      const role = await strapi.db.query('plugin::users-permissions.role').create({
        data: {
          name,
          description: description || `${name} role`,
          type,
          isAdmin: true, // Mark as admin role
          permissions: permissions || []
        }
      });

      console.log(`[ROLE CREATED] Super admin created role: ${name} (${type})`);

      ctx.send({
        success: true,
        message: 'Role created successfully',
        role: {
          id: role.id,
          name: role.name,
          description: role.description,
          type: role.type,
          isAdmin: role.isAdmin,
          permissions: role.permissions
        }
      });

    } catch (error) {
      console.error('[ROLE CREATION ERROR]', error);
      return ctx.badRequest('Error creating role', { error: error.message });
    }
  },

  /**
   * Update an existing admin role
   * Only super admins can update roles
   */
  async updateRole(ctx) {
    try {
      const { id } = ctx.params;
      const { name, description, permissions = [] } = ctx.request.body;

      // Find the role
      const existingRole = await strapi.db.query('plugin::users-permissions.role').findOne({
        where: { id }
      });

      if (!existingRole) {
        return ctx.notFound('Role not found');
      }

      // Prevent updating system roles
      const systemRoles = ['super_admin', 'admin', 'moderator'];
      if (systemRoles.includes(existingRole.type)) {
        return ctx.badRequest('Cannot update system roles');
      }

      // Update the role
      const updatedRole = await strapi.db.query('plugin::users-permissions.role').update({
        where: { id },
        data: {
          name: name || existingRole.name,
          description: description || existingRole.description,
          permissions: permissions || existingRole.permissions
        }
      });

      console.log(`[ROLE UPDATED] Super admin updated role: ${updatedRole.name}`);

      ctx.send({
        success: true,
        message: 'Role updated successfully',
        role: {
          id: updatedRole.id,
          name: updatedRole.name,
          description: updatedRole.description,
          type: updatedRole.type,
          isAdmin: updatedRole.isAdmin,
          permissions: updatedRole.permissions
        }
      });

    } catch (error) {
      console.error('[ROLE UPDATE ERROR]', error);
      return ctx.badRequest('Error updating role', { error: error.message });
    }
  },

  /**
   * Delete an admin role
   * Only super admins can delete roles
   */
  async deleteRole(ctx) {
    try {
      const { id } = ctx.params;

      // Find the role
      const existingRole = await strapi.db.query('plugin::users-permissions.role').findOne({
        where: { id }
      });

      if (!existingRole) {
        return ctx.notFound('Role not found');
      }

      // Prevent deleting system roles
      const systemRoles = ['super_admin', 'admin', 'moderator'];
      if (systemRoles.includes(existingRole.type)) {
        return ctx.badRequest('Cannot delete system roles');
      }

      // Check if any users are assigned to this role
      const usersWithRole = await strapi.db.query('plugin::users-permissions.user').findMany({
        where: { role: id }
      });

      if (usersWithRole.length > 0) {
        return ctx.badRequest(`Cannot delete role. ${usersWithRole.length} users are assigned to this role`);
      }

      // Delete the role
      await strapi.db.query('plugin::users-permissions.role').delete({
        where: { id }
      });

      console.log(`[ROLE DELETED] Super admin deleted role: ${existingRole.name}`);

      ctx.send({
        success: true,
        message: 'Role deleted successfully'
      });

    } catch (error) {
      console.error('[ROLE DELETE ERROR]', error);
      return ctx.badRequest('Error deleting role', { error: error.message });
    }
  },

  /**
   * List all admin roles
   * Only super admins can view all roles
   */
  async listRoles(ctx) {
    try {
      const roles = await strapi.db.query('plugin::users-permissions.role').findMany({
        where: { isAdmin: true },
        orderBy: { name: 'asc' }
      });

      // Get user count for each role
      const rolesWithUserCount = await Promise.all(
        roles.map(async (role) => {
          const userCount = await strapi.db.query('plugin::users-permissions.user').count({
            where: { role: role.id }
          });

          return {
            ...role,
            userCount
          };
        })
      );

      ctx.send({
        success: true,
        roles: rolesWithUserCount
      });

    } catch (error) {
      console.error('[ROLE LIST ERROR]', error);
      return ctx.badRequest('Error listing roles', { error: error.message });
    }
  },

  /**
   * Assign role to user
   * Only super admins can assign roles
   */
  async assignRole(ctx) {
    try {
      const { userId, roleId } = ctx.request.body;

      if (!userId || !roleId) {
        return ctx.badRequest('User ID and Role ID are required');
      }

      // Find the user
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: userId },
        populate: ['role']
      });

      if (!user) {
        return ctx.notFound('User not found');
      }

      // Find the role
      const role = await strapi.db.query('plugin::users-permissions.role').findOne({
        where: { id: roleId }
      });

      if (!role) {
        return ctx.notFound('Role not found');
      }

      // Check if role is an admin role
      if (!role.isAdmin) {
        return ctx.badRequest('Can only assign admin roles through this endpoint');
      }

      // Update user's role
      const updatedUser = await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: userId },
        data: { role: roleId },
        populate: ['role']
      });

      console.log(`[ROLE ASSIGNED] User ${user.email} assigned role: ${role.name}`);

      ctx.send({
        success: true,
        message: 'Role assigned successfully',
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          username: updatedUser.username,
          role: {
            id: updatedUser.role.id,
            name: updatedUser.role.name,
            type: updatedUser.role.type
          }
        }
      });

    } catch (error) {
      console.error('[ROLE ASSIGNMENT ERROR]', error);
      return ctx.badRequest('Error assigning role', { error: error.message });
    }
  },

  /**
   * Remove role from user
   * Only super admins can remove roles
   */
  async removeRole(ctx) {
    try {
      const { userId } = ctx.request.body;

      if (!userId) {
        return ctx.badRequest('User ID is required');
      }

      // Find the user
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: userId },
        populate: ['role']
      });

      if (!user) {
        return ctx.notFound('User not found');
      }

      // Get the default authenticated role
      const defaultRole = await strapi.db.query('plugin::users-permissions.role').findOne({
        where: { type: 'authenticated' }
      });

      if (!defaultRole) {
        return ctx.badRequest('Default authenticated role not found');
      }

      // Update user to default role
      const updatedUser = await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: userId },
        data: { role: defaultRole.id },
        populate: ['role']
      });

      console.log(`[ROLE REMOVED] User ${user.email} role removed, assigned to default role`);

      ctx.send({
        success: true,
        message: 'Role removed successfully',
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          username: updatedUser.username,
          role: {
            id: updatedUser.role.id,
            name: updatedUser.role.name,
            type: updatedUser.role.type
          }
        }
      });

    } catch (error) {
      console.error('[ROLE REMOVAL ERROR]', error);
      return ctx.badRequest('Error removing role', { error: error.message });
    }
  }

}));
