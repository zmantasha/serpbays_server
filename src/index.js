'use strict';

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
