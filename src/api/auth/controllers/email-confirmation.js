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
      
      // Do NOT echo error.message — Strapi-internal errors would leak.
      return ctx.badRequest('Email verification failed', {
        error: 'verification_failed',
      });
    }
  },

  // POST /auth/send-email-confirmation — anonymous "resend my verification
  // email" endpoint. Hardened against:
  //   - Account enumeration: pre-fix returned distinct error codes for
  //     "user not found" vs "already confirmed" vs success. Attacker
  //     could probe `{email: target@example.com}` to learn whether the
  //     target was registered and whether their email was confirmed.
  //     Now always returns the same `{ok: true}` response so the outside
  //     cannot distinguish.
  //   - Resend-cooldown: same email can only trigger a resend every
  //     RESEND_COOLDOWN_MS. Pre-fix an attacker could spam-fill a
  //     victim's inbox with verification emails. Cooldown is enforced
  //     via `confirmationTokenCreatedAt` (set every time a token is
  //     minted) — no schema change.
  async sendVerificationEmail(ctx) {
    const { email } = ctx.request.body || {};
    if (typeof email !== 'string' || !email.includes('@')) {
      // Even malformed inputs get the generic response — don't
      // differentiate "missing/invalid" vs "no such account".
      return ctx.send({ ok: true });
    }

    try {
      const normalized = email.toLowerCase().trim();
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: normalized },
      });

      // Don't reveal "not found" or "already confirmed".
      if (!user || user.confirmed) {
        return ctx.send({ ok: true });
      }

      // Cooldown — prevent email-bomb. 60 seconds between resends per row.
      const RESEND_COOLDOWN_MS = 60_000;
      if (user.confirmationTokenCreatedAt) {
        const age = Date.now() - new Date(user.confirmationTokenCreatedAt).getTime();
        if (age < RESEND_COOLDOWN_MS) {
          // Silently no-op — don't differentiate from success path.
          return ctx.send({ ok: true });
        }
      }

      const customEmailService = strapi.service('api::auth.custom-email-verification');
      const verificationToken = customEmailService.generateVerificationToken();

      await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: user.id },
        data: {
          confirmationToken: verificationToken,
          confirmationTokenCreatedAt: new Date(),
        },
      });

      await customEmailService.sendVerificationEmail(user, verificationToken);
      strapi.log?.info?.(`[AUTH] Verification email sent (id=${user.id})`);

      return ctx.send({ ok: true });

    } catch (error) {
      // Server-side log only. Response stays generic to prevent
      // distinguishing real failures from already-confirmed/not-found.
      strapi.log?.error?.('[AUTH] sendVerificationEmail failed', { error: error.message });
      return ctx.send({ ok: true });
    }
  }
};
