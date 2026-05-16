module.exports = ({ env }) => ({
  'users-permissions': {
    config: {
      register: {
        allowedFields: ['Advertiser', 'Publisher', 'firstName', 'lastName'],
      },
      jwt: {
        expiresIn: '7d',
      },
      jwtSecret: env('JWT_SECRET', 'your-secret-key-here'),
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
