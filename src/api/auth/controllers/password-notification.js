'use strict';

/**
 * Password changed notification controller
 * Called by the client after Clerk successfully changes the password
 */

module.exports = {
  async sendNotification(ctx) {
    try {
      const { email } = ctx.request.body;

      if (!email) {
        return ctx.badRequest('Email is required');
      }

      // Find user by email
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: email.toLowerCase() }
      });

      if (!user) {
        // Don't reveal if user exists or not
        return ctx.send({ ok: true });
      }

      // Send password changed confirmation email via AutoSend
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendPasswordChangedEmail(user);
        console.log(`[AUTH] Password changed email sent to ${user.email}`);
      } catch (emailError) {
        console.error('[AUTH] Failed to send password changed email:', emailError.message);
      }

      ctx.send({ ok: true });
    } catch (error) {
      console.error('[AUTH] Password notification error:', error);
      ctx.send({ ok: true });
    }
  }
};
