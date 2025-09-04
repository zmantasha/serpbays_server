'use strict';

/**
 * Admin Logger Middleware
 * Enhanced logging and security for admin panel operations
 */

module.exports = (config, { strapi }) => {
  return async (ctx, next) => {
    const startTime = Date.now();
    const { method, url, ip } = ctx.request;
    const userAgent = ctx.request.get('User-Agent');
    
    // Log admin request
    console.log(`[ADMIN REQUEST] ${method} ${url} from ${ip}`);
    
    // Add admin context to state
    if (ctx.state.user) {
      ctx.state.isAdminRequest = true;
      ctx.state.adminUser = {
        id: ctx.state.user.id,
        email: ctx.state.user.email,
        role: ctx.state.user.role?.name || ctx.state.user.role?.type
      };
    }

    try {
      await next();
      
      const duration = Date.now() - startTime;
      console.log(`[ADMIN RESPONSE] ${method} ${url} - ${ctx.status} (${duration}ms)`);
      
      // Log successful admin operations
      if (ctx.state.user && ['POST', 'PUT', 'DELETE'].includes(method)) {
        console.log(`[ADMIN ACTION] User ${ctx.state.user.id} performed ${method} on ${url}`);
      }
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[ADMIN ERROR] ${method} ${url} - Error: ${error.message} (${duration}ms)`);
      
      // Log admin errors for security monitoring
      if (ctx.state.user) {
        console.error(`[ADMIN ERROR DETAIL] User ${ctx.state.user.id} encountered error on ${url}:`, error);
      }
      
      throw error;
    }
  };
};

