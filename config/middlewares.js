module.exports = [
  'strapi::errors',
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
      xssProtection: {/* ... */},
      frameguard: {/* ... */},
      cors: {/* ... */},
      csrf: {
        enabled: true,
        ignoredMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
        ignoredRoutes: ['/api/transactions/webhook/:gateway']
      }
    },
  },
  {
    name: 'strapi::cors',
    config: {
      enabled: true,
      headers: [
        'Content-Type',
        'Authorization',
        'authorization',
        'X-Frame-Options',
        'Accept',
        'Origin'
      ],
      origin: ['http://localhost:3000', 'http://localhost:1337', 'http://localhost:3800'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      keepHeaderOnError: true,
      maxAge: 86400
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
