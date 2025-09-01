'use strict';

const websocketBootstrap = require('./bootstrap/websocket');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    // Initialize WebSocket after Strapi is ready
    await websocketBootstrap({ strapi });

    // Register admin routes
    const adminRoutes = [
      require('./api/admin/routes/admin'),
      require('./api/admin/routes/users'),
      require('./api/admin/routes/orders'),
      require('./api/admin/routes/transactions'),
      require('./api/admin/routes/communications'),
      require('./api/admin/routes/websites'),
      require('./api/admin/routes/website-requests'),
      require('./api/admin/routes/marketplace')
    ];

    adminRoutes.forEach(routeConfig => {
      if (routeConfig.routes) {
        routeConfig.routes.forEach(route => {
          strapi.server.routes(route);
        });
      }
    });

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
