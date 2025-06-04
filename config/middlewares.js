module.exports = [
  'strapi::errors',
  'strapi::cors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'dl.airtable.com', 'res.cloudinary.com'],
          'media-src': ["'self'", 'data:', 'blob:', 'dl.airtable.com', 'res.cloudinary.com'],
          upgradeInsecureRequests: null,
        },
      },
      xssProtection: {
        enabled: true,
        mode: 'block'
      },
      frameguard: {
        enabled: true,
        action: 'sameorigin'
      },
      csrf: {
        enabled: true,
        ignoredMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
        ignoredRoutes: ['/api/transactions/webhook/:gateway']
      }
    },
  },
  'strapi::poweredBy',
  'strapi::logger',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
