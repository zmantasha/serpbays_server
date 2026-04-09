'use strict';

const websocketBootstrap = require('./bootstrap/websocket');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) { },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    // SUPPRESS LOGS IN PRODUCTION
    if (process.env.NODE_ENV === 'production') {
      const noop = () => { };
      console.log = noop;
      console.warn = noop;
      console.info = noop;
      // console.error is KEPT intentionally for critical failures
    }

    // Ensure database-level unique indexes exist on the users table.
    // Strapi's schema "unique: true" only enforces at the ORM level,
    // which doesn't prevent duplicates under concurrent requests.
    // These DB indexes are the ultimate safety net.
    try {
      const knex = strapi.db.connection;

      // Detect DB client — Strapi/Knex exposes this in multiple places
      const clientName = (
        knex.client.config.client ||
        knex.client.constructor.name ||
        ''
      ).toLowerCase();
      const isSQLite = clientName.includes('sqlite') || clientName.includes('better-sqlite');
      const isPostgres = clientName.includes('pg') || clientName.includes('postgres');

      strapi.log.info(`[BOOTSTRAP] Database client detected: "${clientName}" (sqlite=${isSQLite}, pg=${isPostgres})`);

      if (isSQLite || isPostgres) {
        // SQLite and PostgreSQL both support CREATE UNIQUE INDEX IF NOT EXISTS
        // and partial indexes with WHERE clause
        await knex.raw(
          'CREATE UNIQUE INDEX IF NOT EXISTS "up_users_clerk_id_unique" ON "up_users" ("clerk_id") WHERE "clerk_id" IS NOT NULL'
        ).catch((err) => {
          strapi.log.warn(`[BOOTSTRAP] Could not create clerk_id unique index: ${err.message}`);
        });
        await knex.raw(
          'CREATE UNIQUE INDEX IF NOT EXISTS "up_users_email_unique" ON "up_users" ("email") WHERE "email" IS NOT NULL'
        ).catch((err) => {
          strapi.log.warn(`[BOOTSTRAP] Could not create email unique index: ${err.message}`);
        });
      } else {
        // MySQL — use ALTER TABLE with IGNORE for idempotency
        await knex.raw(
          'CREATE UNIQUE INDEX `up_users_clerk_id_unique` ON `up_users` (`clerk_id`)'
        ).catch((err) => {
          // Error code 1061 = Duplicate key name (index already exists) — safe to ignore
          if (err.errno !== 1061) {
            strapi.log.warn(`[BOOTSTRAP] Could not create clerk_id unique index: ${err.message}`);
          }
        });
        await knex.raw(
          'CREATE UNIQUE INDEX `up_users_email_unique` ON `up_users` (`email`)'
        ).catch((err) => {
          if (err.errno !== 1061) {
            strapi.log.warn(`[BOOTSTRAP] Could not create email unique index: ${err.message}`);
          }
        });
      }
      strapi.log.info('[BOOTSTRAP] Database unique indexes ensured on up_users (clerk_id, email)');
    } catch (err) {
      strapi.log.warn(`[BOOTSTRAP] Could not verify/create unique indexes: ${err.message}`);
    }

    // Initialize WebSocket after Strapi is ready
    await websocketBootstrap({ strapi });

    // Register admin routes
    const adminRoutes = [
      require('./api/admin/routes/admin'),
      require('./api/admin/routes/role-management'),
      require('./api/admin/routes/users'),
      require('./api/admin/routes/orders'),
      require('./api/admin/routes/transactions'),
      require('./api/admin/routes/communications'),
      require('./api/admin/routes/websites'),
      require('./api/admin/routes/website-requests'),
      require('./api/admin/routes/marketplace'),
      require('./api/admin/routes/withdrawals'),
      require('./api/admin/routes/codes')
    ];

    adminRoutes.forEach(routeConfig => {
      if (routeConfig.routes) {
        routeConfig.routes.forEach(route => {
          strapi.server.routes(route);
        });
      }
    });

    // Ensure the `Authenticated` role can use the Upload plugin. This
    // is what lets the cart's document importer push images to the
    // media library via POST /api/upload. Without this permission the
    // plugin returns 403 and the importer falls back to base64 data
    // URIs, re-introducing the localStorage quota bug Option 1 was
    // designed to fix. The routine is idempotent — it only writes if
    // the permission row is missing or currently disabled.
    try {
      const authenticatedRole = await strapi.db
        .query('plugin::users-permissions.role')
        .findOne({ where: { type: 'authenticated' } });

      if (authenticatedRole) {
        const uploadActions = [
          'plugin::upload.content-api.upload',
          'plugin::upload.content-api.find',
        ];

        for (const action of uploadActions) {
          const existing = await strapi.db
            .query('plugin::users-permissions.permission')
            .findOne({
              where: {
                action,
                role: authenticatedRole.id,
              },
            });

          if (!existing) {
            await strapi.db.query('plugin::users-permissions.permission').create({
              data: {
                action,
                role: authenticatedRole.id,
              },
            });
            strapi.log.info(`[BOOTSTRAP] Granted ${action} to Authenticated role`);
          }
        }
      } else {
        strapi.log.warn('[BOOTSTRAP] Authenticated role not found — skipping upload permission grant');
      }
    } catch (permErr) {
      strapi.log.warn(
        `[BOOTSTRAP] Failed to grant upload permission to Authenticated role: ${permErr.message}`
      );
    }

    // Add request debugging middleware
    strapi.server.use(async (ctx, next) => {
      // Log the request details for debugging
      console.log(`[${new Date().toISOString()}] ${ctx.method} ${ctx.url}`);

      // Log authentication info
      if (ctx.state?.user?.id) {
        console.log(`Request by authenticated user: ${ctx.state.user.id}`);
      } else {
        console.log('Request by unauthenticated user');
      }

      // Continue with the request
      await next();
    });
  },
};
