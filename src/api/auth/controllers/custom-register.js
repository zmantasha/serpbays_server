'use strict';

/**
 * Custom registration controller
 * Handles user registration with custom email verification
 * This bypasses the users-permissions plugin entirely
 */

module.exports = {
  async register(ctx) {
    try {
      const { username, email, password, firstName, lastName, Advertiser, Publisher } = ctx.request.body;

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

      // Use the same password hashing method as Strapi
      // Strapi uses bcrypt with salt rounds of 10
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user with custom verification (NOT confirmed)
      const user = await strapi.db.query('plugin::users-permissions.user').create({
        data: {
          username,
          email,
          password: hashedPassword,
          firstName: firstName || '',
          lastName: lastName || '',
          confirmed: false, // Not confirmed until email verification
          blocked: false,
          role: defaultRole.id,
          provider: 'local',
          confirmationToken: verificationToken,
          confirmationTokenCreatedAt: new Date(),
          // Handle custom fields
          Advertiser: Advertiser || false,
          Publisher: Publisher !== false // Default to true unless explicitly false
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

      console.log(`✅ User registered with custom verification: ${user.email} (ID: ${user.id})`);

      ctx.send({
        success: true,
        message: 'Registration successful. Please check your email to verify your account.',
        data: {
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            confirmed: user.confirmed,
            Advertiser: user.Advertiser,
            Publisher: user.Publisher
          }
        }
      });
    } catch (error) {
      console.error('Registration error:', error);
      ctx.internalServerError('Registration failed. Please try again.');
    }
  }
};