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
});
