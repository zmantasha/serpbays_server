module.exports = ({ env }) => ({
  'users-permissions': {
    config: {
      register: {
        allowedFields: ['Advertiser', 'Publisher'],
      },
      jwt: {
        expiresIn: '7d',
      },
      jwtSecret: env('JWT_SECRET', 'your-secret-key-here'),
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
  'email': {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'smtp.gmail.com'),
        port: parseInt(env('SMTP_PORT', '587')),
        auth: {
          user: env('SMTP_USERNAME'),
          pass: env('SMTP_PASSWORD'),
        },
        // Gmail specific settings
        secure: env('SMTP_PORT', '587') === '465', // true for 465, false for other ports
        requireTLS: true,
        tls: {
          rejectUnauthorized: false
        },
        debug: true, // Enable debug logging
        logger: true, // Log to console
      },
      settings: {
        defaultFrom: env('EMAIL_FROM', 'noreply@serpbays.com'),
        defaultReplyTo: env('EMAIL_REPLY_TO', 'support@serpbays.com'),
      },
    },
  },
});
