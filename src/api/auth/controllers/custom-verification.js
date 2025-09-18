'use strict';

/**
 * Custom verification controller
 * Handles custom email verification flow
 */

module.exports = {
  /**
   * Send verification email
   */
  async sendVerificationEmail(ctx) {
    try {
      const { email } = ctx.request.body;

      if (!email) {
        return ctx.badRequest('Email is required');
      }

      const customEmailService = strapi.service('api::auth.custom-email-verification');
      const result = await customEmailService.resendVerificationEmail(email);

      ctx.send({
        success: true,
        message: 'Verification email sent successfully',
        data: result
      });
    } catch (error) {
      console.error('Error sending verification email:', error);
      ctx.badRequest(error.message || 'Failed to send verification email');
    }
  },

  /**
   * Verify email with token
   */
  async verifyEmail(ctx) {
    try {
      const { confirmation: token, email } = ctx.query;
      console

      if (!token) {
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
        return ctx.redirect(`${clientUrl}/email-verification?error=invalid_token`);
      }

      // If no email provided, try to find user by token
      let userEmail = email;
      if (!userEmail) {
        const user = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { confirmationToken: token }
        });
        if (user) {
          userEmail = user.email;
        }
      }

      if (!userEmail) {
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
        return ctx.redirect(`${clientUrl}/email-verification?error=invalid_token`);
      }

      const customEmailService = strapi.service('api::auth.custom-email-verification');
      const result = await customEmailService.verifyEmail(token, userEmail);

      // Redirect to frontend with success
      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
      return ctx.redirect(`${clientUrl}/email-verification?verified=true`);
    } catch (error) {
      console.error('Error verifying email:', error);
      
      // Handle different error types
      let errorType = 'verification_failed';
      
      if (error.message.includes('Invalid or expired')) {
        errorType = 'invalid_token';
      } else if (error.message.includes('expired')) {
        errorType = 'expired_token';
      } else if (error.message.includes('already verified')) {
        errorType = 'already_confirmed';
      }
      
      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
      return ctx.redirect(`${clientUrl}/email-verification?error=${errorType}&email=${encodeURIComponent(ctx.query.email || '')}`);
    }
  }
};
