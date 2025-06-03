module.exports = ({ env }) => ({
  'users-permissions': {
    config: {
      jwt: {
        expiresIn: '7d',
      },
      jwtSecret: env('JWT_SECRET', 'your-secret-key'),
      ratelimit: {
        interval: 60000,
        max: 100,
      },
      layout: {
        user: {
          actions: {
            create: false,
            update: false,
            delete: false,
          },
        },
      },
    },
  },
  'upload': {
    config: {
      provider: 'local',
      providerOptions: {
        sizeLimit: 100000,
      },
    },
  },
});
