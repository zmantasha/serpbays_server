module.exports = [
  'strapi::errors',
  {
    name: 'strapi::cors',
    config: {
      enabled: true,
      headers: [
        'Content-Type',
        'Authorization',
        'Origin',
        'Accept',
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers'
      ],
      origin: [
        'http://localhost:3000',
        'http://localhost:1337',
        'http://localhost:3800',
        'http://staging.serpbays.com',
        'https://staging.serpbays.com',
        'https://cms.serpbays.com'
      ],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      credentials: true,
      maxAge: 86400
    }
  },
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:', 'http:', 'ws:', 'wss:'],
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
