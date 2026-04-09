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
      origin: ['https://staging.serpbays.com', 'http://staging.serpbays.com','http://localhost:3000','https://panel20.serpbays.com','http://localhost:3009','https://prod-panel20.serpbays.com','https://app.serpbays.com'],
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
      // Formidable multipart limits — must be >= the upload plugin's
      // per-file sizeLimit (currently 10 MB in config/plugins.js) or
      // Koa will reject the request before Strapi's upload service
      // ever sees it.
      formLimit: '12mb',
      jsonLimit: '12mb',
      textLimit: '12mb',
      formidable: {
        maxFileSize: 12 * 1024 * 1024, // 12 MB per file (headroom over upload plugin)
      },
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