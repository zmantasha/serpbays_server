'use strict';

/**
 * Custom email confirmation controller
 * Handles email confirmation with proper error handling and redirects
 */

module.exports = {
  async emailConfirmation(ctx) {
    const { confirmation } = ctx.query;
    
    if (!confirmation) {
      return ctx.badRequest('Confirmation token is required', {
        error: 'invalid_token',
        details: 'No confirmation token provided'
      });
    }
    
    try {
      // Use our custom email verification service instead of Strapi's default
      const customEmailService = strapi.service('api::auth.custom-email-verification');
      
      // Find user by confirmation token
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: {
          confirmationToken: confirmation,
          confirmed: false
        }
      });

      if (!user) {
        return ctx.badRequest('Invalid or expired verification token', {
          error: 'invalid_token',
          details: 'Token not found or user already confirmed'
        });
      }

      // Check if token is expired (24 hours)
      const tokenAge = Date.now() - new Date(user.confirmationTokenCreatedAt).getTime();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

      if (tokenAge > maxAge) {
        return ctx.badRequest('Verification token has expired', {
          error: 'expired_token',
          details: 'Token is older than 24 hours'
        });
      }

      // Update user as confirmed
      await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: user.id },
        data: {
          confirmed: true,
          confirmationToken: null,
          confirmationTokenCreatedAt: null
        }
      });

      console.log(`✅ Email verified for user ${user.email}`);
      
      // Return success response
      return ctx.send({
        success: true,
        message: 'Email verified successfully',
        user: {
          id: user.id,
          email: user.email,
          confirmed: true
        }
      });
      
    } catch (error) {
      console.error('Email confirmation error:', error);
      
      // Return JSON error response
      return ctx.badRequest('Email verification failed', {
        error: 'verification_failed',
        details: error.message
      });
    }
  },

  async sendVerificationEmail(ctx) {
    const { email } = ctx.request.body;
    
    if (!email) {
      return ctx.badRequest('Email is required', {
        error: 'missing_email',
        details: 'Email parameter is required'
      });
    }
    
    try {
      // Find user by email
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: email }
      });

      if (!user) {
        return ctx.badRequest('User not found', {
          error: 'user_not_found',
          details: 'No user found with this email address'
        });
      }

      if (user.confirmed) {
        return ctx.badRequest('Email already verified', {
          error: 'already_confirmed',
          details: 'This email is already verified'
        });
      }

      // Generate new verification token
      const customEmailService = strapi.service('api::auth.custom-email-verification');
      const verificationToken = customEmailService.generateVerificationToken();

      // Update user with new token
      await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: user.id },
        data: {
          confirmationToken: verificationToken,
          confirmationTokenCreatedAt: new Date()
        }
      });

      // Send verification email
      await customEmailService.sendVerificationEmail(user, verificationToken);

      console.log(`✅ Verification email sent to ${user.email}`);
      
      return ctx.send({
        success: true,
        message: 'Verification email sent successfully'
      });
      
    } catch (error) {
      console.error('Send verification email error:', error);
      
      return ctx.badRequest('Failed to send verification email', {
        error: 'send_failed',
        details: error.message
      });
    }
  }
};
