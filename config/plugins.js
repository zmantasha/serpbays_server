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
  // Email plugin configuration (kept for backwards compatibility)
  // NOTE: AutoSend is now used directly via autosend-service.js instead of this plugin
  'email': {
    config: {
      provider: 'nodemailer',
      settings: {
        defaultFrom: env('EMAIL_FROM', 'noreply@serpbays.com'),
        defaultReplyTo: env('EMAIL_REPLY_TO', 'support@serpbays.com'),
      },
    },
  },
});
