'use strict';

/**
 * Admin Management Controller
 *
 * Super-admin-only endpoints to create, list, update, and delete admin users
 * with per-user pagePermissions. The role assignment is always 'admin'
 * (super_admin and moderator are not assignable via this API — super_admin
 * is hardcoded all-access; moderator is being retired).
 */

const { createCoreController } = require('@strapi/strapi').factories;
const {
  ADMIN_PAGES,
  ADMIN_PAGE_KEYS,
  normalizePermissions,
  resolvePermissions,
} = require('../../../lib/admin-pages');

async function findAdminRole(strapi) {
  return strapi.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'admin' },
  });
}

async function writeAudit(strapi, ctx, { action, targetUserId, details }) {
  try {
    await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
      data: {
        adminUser: ctx.state.user.id,
        action,
        targetUser: targetUserId || null,
        details: details || {},
        ipAddress: ctx.request.ip || ctx.request.headers['x-forwarded-for'] || null,
        userAgent: ctx.request.headers['user-agent'] || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    // Audit failure must never block the action — log and continue.
    strapi.log.warn(`[ADMIN-MGMT] audit write failed: ${err.message}`);
  }
}

function shapeAdmin(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    confirmed: user.confirmed,
    blocked: user.blocked,
    role: user.role
      ? { id: user.role.id, name: user.role.name, type: user.role.type }
      : null,
    pagePermissions: resolvePermissions(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

module.exports = createCoreController('plugin::users-permissions.user', ({ strapi }) => ({

  /**
   * GET /admin/page-registry
   * Returns the list of gateable pages — the source of truth for the
   * permission grid UI on the frontend.
   */
  async getPageRegistry(ctx) {
    ctx.send({ pages: ADMIN_PAGES });
  },

  /**
   * GET /admin/admins
   * List all admin users (super_admin + admin role types) with resolved
   * pagePermissions. Super admins show as locked rows in the UI.
   */
  async listAdmins(ctx) {
    try {
      const users = await strapi.entityService.findMany(
        'plugin::users-permissions.user',
        {
          filters: { role: { type: { $in: ['super_admin', 'admin'] } } },
          populate: ['role'],
          fields: [
            'id',
            'username',
            'email',
            'firstName',
            'lastName',
            'confirmed',
            'blocked',
            'pagePermissions',
            'createdAt',
            'updatedAt',
          ],
          sort: { createdAt: 'asc' },
        },
      );

      ctx.send({ admins: users.map(shapeAdmin) });
    } catch (err) {
      strapi.log.error('[ADMIN-MGMT] listAdmins error', err);
      return ctx.internalServerError('Failed to list admins');
    }
  },

  /**
   * POST /admin/admins
   * Create a new admin user.
   * Body: { email, password, username?, firstName?, lastName?, pagePermissions? }
   */
  async createAdmin(ctx) {
    try {
      const { email, password, username, firstName, lastName, pagePermissions } =
        ctx.request.body || {};

      if (!email || !password) {
        return ctx.badRequest('Email and password are required');
      }
      if (typeof password !== 'string' || password.length < 8) {
        return ctx.badRequest('Password must be at least 8 characters');
      }

      const adminRole = await findAdminRole(strapi);
      if (!adminRole) {
        return ctx.internalServerError(
          "Admin role not found. Run 'node scripts/migrate-permissions.js' to seed it.",
        );
      }

      const existing = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { $or: [{ email }, { username: username || email }] },
      });
      if (existing) {
        return ctx.badRequest('A user with this email or username already exists');
      }

      const normalized = normalizePermissions(pagePermissions);

      const created = await strapi.plugins['users-permissions'].services.user.add({
        username: username || email,
        email,
        password,
        firstName: firstName || null,
        lastName: lastName || null,
        confirmed: true,
        blocked: false,
        role: adminRole.id,
        provider: 'local',
        pagePermissions: normalized,
      });

      const full = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        created.id,
        { populate: ['role'] },
      );

      await writeAudit(strapi, ctx, {
        action: 'admin.create',
        targetUserId: created.id,
        details: { email, permissions: normalized },
      });

      ctx.send({ admin: shapeAdmin(full) });
    } catch (err) {
      strapi.log.error('[ADMIN-MGMT] createAdmin error', err);
      return ctx.badRequest(err.message || 'Failed to create admin');
    }
  },

  /**
   * PUT /admin/admins/:id
   * Update an admin user's basic fields (name, email, blocked).
   * Permissions live on a separate endpoint.
   */
  async updateAdmin(ctx) {
    try {
      const { id } = ctx.params;
      const { email, username, firstName, lastName, blocked } = ctx.request.body || {};

      const existing = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        id,
        { populate: ['role'] },
      );
      if (!existing) return ctx.notFound('Admin not found');
      if (!['super_admin', 'admin'].includes(existing.role?.type)) {
        return ctx.badRequest('User is not an admin');
      }
      if (existing.role?.type === 'super_admin' && Number(ctx.state.user.id) !== Number(id)) {
        return ctx.forbidden('Super admin profile can only be edited by themselves');
      }

      const data = {};
      if (typeof email === 'string') data.email = email;
      if (typeof username === 'string') data.username = username;
      if (typeof firstName === 'string') data.firstName = firstName;
      if (typeof lastName === 'string') data.lastName = lastName;
      if (typeof blocked === 'boolean' && existing.role?.type !== 'super_admin') {
        data.blocked = blocked;
      }

      const updated = await strapi.entityService.update(
        'plugin::users-permissions.user',
        id,
        { data, populate: ['role'] },
      );

      await writeAudit(strapi, ctx, {
        action: 'admin.update',
        targetUserId: id,
        details: { changed: Object.keys(data) },
      });

      ctx.send({ admin: shapeAdmin(updated) });
    } catch (err) {
      strapi.log.error('[ADMIN-MGMT] updateAdmin error', err);
      return ctx.badRequest(err.message || 'Failed to update admin');
    }
  },

  /**
   * PUT /admin/admins/:id/permissions
   * Replace the admin user's pagePermissions map.
   * Body: { pagePermissions: { [pageKey]: { view, edit } } }
   * super_admin permissions are not editable.
   */
  async updateAdminPermissions(ctx) {
    try {
      const { id } = ctx.params;
      const { pagePermissions } = ctx.request.body || {};

      if (!pagePermissions || typeof pagePermissions !== 'object') {
        return ctx.badRequest('pagePermissions is required');
      }

      const existing = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        id,
        { populate: ['role'], fields: ['id', 'email', 'pagePermissions'] },
      );
      if (!existing) return ctx.notFound('Admin not found');
      if (existing.role?.type === 'super_admin') {
        return ctx.badRequest('Super admin permissions are not editable');
      }
      if (existing.role?.type !== 'admin') {
        return ctx.badRequest('Target user is not an admin');
      }

      const normalized = normalizePermissions(pagePermissions);

      const updated = await strapi.entityService.update(
        'plugin::users-permissions.user',
        id,
        {
          data: { pagePermissions: normalized },
          populate: ['role'],
        },
      );

      await writeAudit(strapi, ctx, {
        action: 'admin.permissions.update',
        targetUserId: id,
        details: {
          before: existing.pagePermissions || {},
          after: normalized,
        },
      });

      ctx.send({ admin: shapeAdmin(updated) });
    } catch (err) {
      strapi.log.error('[ADMIN-MGMT] updateAdminPermissions error', err);
      return ctx.badRequest(err.message || 'Failed to update permissions');
    }
  },

  /**
   * DELETE /admin/admins/:id
   * Remove an admin user. super_admin and self-deletion are not allowed.
   */
  async deleteAdmin(ctx) {
    try {
      const { id } = ctx.params;

      const existing = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        id,
        { populate: ['role'] },
      );
      if (!existing) return ctx.notFound('Admin not found');
      if (existing.role?.type === 'super_admin') {
        return ctx.badRequest('Super admin cannot be deleted');
      }
      if (Number(ctx.state.user.id) === Number(id)) {
        return ctx.badRequest('You cannot delete your own account');
      }
      if (existing.role?.type !== 'admin') {
        return ctx.badRequest('Target user is not an admin');
      }

      await strapi.entityService.delete('plugin::users-permissions.user', id);

      await writeAudit(strapi, ctx, {
        action: 'admin.delete',
        targetUserId: id,
        details: { email: existing.email },
      });

      ctx.send({ success: true });
    } catch (err) {
      strapi.log.error('[ADMIN-MGMT] deleteAdmin error', err);
      return ctx.badRequest(err.message || 'Failed to delete admin');
    }
  },

}));
