'use strict';

const crypto = require('crypto');

/**
 * Custom email verification service
 * Handles sending verification emails with frontend domain
 */

module.exports = ({ strapi }) => ({
  /**
   * Generate a secure verification token
   */
  generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Send custom verification email
   */
  async sendVerificationEmail(user, token) {
    try {
      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
      const verificationUrl = `${clientUrl}/email-verification?confirmation=${token}&email=${encodeURIComponent(user.email)}`;
      
      const emailTemplate = {
        to: user.email,
        from: {
          name: 'SerpBays',
          email: process.env.EMAIL_FROM || 'noreply@serpbays.com'
        },
        replyTo: process.env.EMAIL_REPLY_TO || 'support@serpbays.com',
        subject: 'Welcome to SerpBays - Please Verify Your Email',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
            <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #3b82f6; margin: 0;">SerpBays</h1>
                <p style="color: #6b7280; margin: 10px 0 0 0;">Email Verification</p>
              </div>
              
              <h2 style="color: #374151; margin-bottom: 20px;">Welcome ${user.username || user.email}!</h2>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 25px;">
                Thank you for joining SerpBays! To complete your registration and secure your account, 
                please verify your email address by clicking the button below:
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationUrl}" 
                   style="background: #10b981; color: white; padding: 12px 30px; 
                          text-decoration: none; border-radius: 6px; font-weight: bold;
                          display: inline-block;">
                  Verify My Email
                </a>
              </div>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                Once verified, you'll be able to access all SerpBays features including our marketplace,
                content creation tools, and more.
              </p>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                If you didn't create this account, you can safely ignore this email.
              </p>
              
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
              
              <p style="color: #9ca3af; font-size: 14px; text-align: center;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="${verificationUrl}" style="color: #3b82f6;">${verificationUrl}</a>
              </p>
            </div>
          </div>
        `
      };

      // Send email using Strapi's email service
      await strapi.plugins.email.services.email.send(emailTemplate);
      
      console.log(`✅ Custom verification email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('❌ Error sending custom verification email:', error);
      throw error;
    }
  },

  /**
   * Verify email with custom token
   */
  async verifyEmail(token, email) {
    try {
      // Find user by email and token
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: {
          email: email,
          confirmationToken: token,
          confirmed: false
        }
      });

      if (!user) {
        throw new Error('Invalid or expired verification token');
      }

      // Check if token is expired (24 hours)
      const tokenAge = Date.now() - new Date(user.confirmationTokenCreatedAt).getTime();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

      if (tokenAge > maxAge) {
        throw new Error('Verification token has expired');
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
      return { success: true, user };
    } catch (error) {
      console.error('❌ Error verifying email:', error);
      throw error;
    }
  },

  /**
   * Resend verification email
   */
  async resendVerificationEmail(email) {
    try {
      // Find user by email
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: email }
      });

      if (!user) {
        throw new Error('User not found');
      }

      if (user.confirmed) {
        throw new Error('Email is already verified');
      }

      // Generate new token
      const token = this.generateVerificationToken();
      
      // Update user with new token
      await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: user.id },
        data: {
          confirmationToken: token,
          confirmationTokenCreatedAt: new Date()
        }
      });

      // Send verification email
      await this.sendVerificationEmail(user, token);
      
      return { success: true, message: 'Verification email sent' };
    } catch (error) {
      console.error('❌ Error resending verification email:', error);
      throw error;
    }
  }
});
