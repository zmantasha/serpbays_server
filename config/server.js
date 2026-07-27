module.exports = ({ env }) => ({
  url: env('SERVER_URL', 'http://localhost:1337'),
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),

  // Trust reverse-proxy headers (X-Forwarded-For, X-Forwarded-Proto, …).
  // Without this, koa's ctx.request.ip returns the socket peer address —
  // which for a Cloudflare → nginx → node stack is 127.0.0.1 for every
  // request. That caused every affiliate signup to look like it came
  // from the same IP and mis-fire the anti-self-referral guard. See the
  // shared getClientIp() helper in src/utils/get-client-ip.js for the
  // header-priority chain used downstream.
  proxy: true,

  app: {
    keys: env.array('APP_KEYS'),
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
  cron: {
    enabled: env.bool('CRON_ENABLED', true),
    tasks: require('../src/cron/index'),
  },
});
