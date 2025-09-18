'use strict';

/**
 * Override users-permissions auth controller
 * Prevents default email confirmation and uses custom system
 */

module.exports = {
  // Override the register method to prevent default email sending
  async register(ctx) {
    // Get the original controller
    const originalController = strapi.plugins['users-permissions'].controllers.auth;
    
    try {
      const { username, email, password, firstName, lastName } = ctx.request.body;

      // Validate required fields
      if (!username || !email || !password) {
        return ctx.badRequest('Username, email, and password are required');
      }

      // Check if user already exists
      const existingUser = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: email }
      });

      if (existingUser) {
        if (existingUser.confirmed) {
          return ctx.badRequest('User with this email already exists and is verified');
        } else {
          // User exists but not confirmed, resend verification
          const customEmailService = strapi.service('api::auth.custom-email-verification');
          await customEmailService.resendVerificationEmail(email);
          
          return ctx.send({
            success: true,
            message: 'User already exists but not verified. Verification email sent.',
            data: { email, verified: false }
          });
        }
      }

      // Get the default role (authenticated)
      const defaultRole = await strapi.db.query('plugin::users-permissions.role').findOne({
        where: { type: 'authenticated' }
      });

      if (!defaultRole) {
        return ctx.internalServerError('Default role not found');
      }

      // Generate verification token
      const customEmailService = strapi.service('api::auth.custom-email-verification');
      const verificationToken = customEmailService.generateVerificationToken();

      // Create user with custom verification (NOT confirmed)
      const user = await strapi.db.query('plugin::users-permissions.user').create({
        data: {
          username,
          email,
          password: await strapi.plugins['users-permissions'].services.user.hashPassword(password),
          firstName: firstName || '',
          lastName: lastName || '',
          confirmed: false, // Not confirmed until email verification
          blocked: false,
          role: defaultRole.id,
          provider: 'local',
          confirmationToken: verificationToken,
          confirmationTokenCreatedAt: new Date()
        }
      });

      // Send custom verification email (with frontend domain)
      await customEmailService.sendVerificationEmail(user, verificationToken);

      // Create wallet for the user
      try {
        await strapi.controller('api::user-wallet.user-wallet').getOrCreateWallet(user.id);
        console.log(`💰 Wallet created for user ${user.id}`);
      } catch (walletError) {
        console.log('⚠️  Wallet creation failed:', walletError.message);
      }

      // Set Publisher field if not explicitly provided
      if (user.Publisher === undefined) {
        await strapi.db.query('plugin::users-permissions.user').update({
          where: { id: user.id },
          data: { Publisher: true }
        });
      }

      console.log(`✅ User registered with custom verification: ${user.email} (ID: ${user.id})`);

      ctx.send({
        success: true,
        message: 'Registration successful. Please check your email to verify your account.',
        data: {
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            confirmed: user.confirmed
          }
        }
      });
    } catch (error) {
      console.error('Registration error:', error);
      ctx.internalServerError('Registration failed. Please try again.');
    }
  },

  // Override emailConfirmation to prevent default behavior
  async emailConfirmation(ctx) {
    // Redirect to our custom verification endpoint
    const { confirmation } = ctx.query;
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    
    if (!confirmation) {
      return ctx.redirect(`${clientUrl}/email-verification?error=invalid_token`);
    }

    // Redirect to our custom verification endpoint
    return ctx.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/api/api/auth/verify-email?confirmation=${confirmation}`);
  },

  // Override login to handle custom verification
  async callback(ctx) {
    // Call the original callback method
    const originalController = strapi.plugins['users-permissions'].controllers.auth;
    return originalController.callback(ctx);
  }
};