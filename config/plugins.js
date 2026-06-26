// CATASTROPHIC pre-fix: the jwtSecret config used `env('JWT_SECRET',
// 'your-secret-key-here')` — a hardcoded fallback. If JWT_SECRET was
// unset in the production environment (Docker misconfig, env file not
// loaded, runtime override missing), Strapi silently signed every JWT
// with the literal string 'your-secret-key-here'. Anyone reading the
// repo would know the signing key, and could forge a JWT for ANY user
// — instant platform-wide account takeover.
// Fix: load JWT_SECRET strictly; throw at boot if unset. A
// misconfigured deploy now crashes loudly instead of silently shipping
// a forgeable signing key.
function requireSecret(env, name) {
  const v = env(name);
  if (!v || typeof v !== 'string' || v.length < 16) {
    throw new Error(
      `[config/plugins.js] ${name} is required and must be at least 16 characters. ` +
      'Refusing to start with a missing or weak secret.'
    );
  }
  return v;
}

module.exports = ({ env }) => ({
  'users-permissions': {
    config: {
      register: {
        allowedFields: ['Advertiser', 'Publisher', 'firstName', 'lastName'],
      },
      jwt: {
        expiresIn: '7d',
      },
      jwtSecret: requireSecret(env, 'JWT_SECRET'),
      // Enable registration and email confirmation
      allow_register: true,
      email_confirmation: true,
      email_confirmation_redirection: `${env('CLIENT_URL', 'http://localhost:3000')}/email-verification`,
      email_reset_password: `${env('CLIENT_URL', 'http://localhost:3000')}/reset-password`,
      default_role: 'authenticated'
    }
  },
  'upload': {
    config: {
      provider: 'local',
      providerOptions: {
        sizeLimit: 100000,
      },
    },
  },
  // Email plugin configuration. Most flows now go through autosend-service.js,
  // but a few still call strapi.plugins.email.services.email.send directly
  // (e.g. withdrawal OTP), so the SMTP transport must be wired up here too.
  // Without providerOptions, nodemailer silently falls back to 127.0.0.1:587.
  'email': {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'smtp.gmail.com'),
        port: env.int('SMTP_PORT', 587),
        secure: env.bool('SMTP_SECURE', false),
        auth: {
          user: env('SMTP_USERNAME'),
          pass: env('SMTP_PASSWORD'),
        },
      },
      settings: {
        defaultFrom: env('EMAIL_FROM', 'noreply@serpbays.com'),
        defaultReplyTo: env('EMAIL_REPLY_TO', 'support@serpbays.com'),
      },
    },
  },
});
