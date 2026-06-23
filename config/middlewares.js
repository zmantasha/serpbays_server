module.exports = [
  'strapi::errors',
  // Response compression (gzip / brotli). Strapi 5 ships this but it's
  // opt-in. JSON payloads from /api/marketplace, /api/orders, etc. shrink
  // 4-8x over the wire — direct page-load latency win on every request.
  // Placed early in the chain so it wraps everything downstream.
  'strapi::compression',
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
      includeUnparsed: true, // Preserve raw body for webhook signature verification (Razorpay/PayPal/Stripe)
      // Aligned with nginx client_max_body_size on prod-cms.serpbays.com.
      // Order/cart endpoints accept up to 10 MB rich-text content; uploads route is separate.
      jsonLimit: '10mb',
      formLimit: '10mb',
      textLimit: '10mb',
      formidable: {
        maxFileSize: 50 * 1024 * 1024, // 50 MB — matches nginx /api/upload limit
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