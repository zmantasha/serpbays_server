module.exports = [
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'media-src': ["'self'", 'data:', 'blob:', 'https:'],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      enabled: true,
      origin: ['https://staging.serpbays.com', 'http://staging.serpbays.com', 'http://localhost:3000', 'http://localhost:3001', 'https://panel20.serpbays.com', 'http://localhost:3009'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Requested-With', 'Cache-Control', 'Pragma'],
      credentials: true,
      keepHeaderOnError: true,
    },
  },
  'strapi::poweredBy',
  'strapi::logger',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      includeUnparsed: true, // This preserves the raw body for webhook verification
    },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  // Custom admin middleware
  'global::admin-logger',
  // Custom response sanitizer to remove sensitive fields
  // Temporarily disabled for testing - might be blocking publisher email
  // 'global::response-sanitizer',
];