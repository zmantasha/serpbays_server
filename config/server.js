module.exports = ({ env }) => ({
  // url: env('SERVER_URL', 'https://cms.serpbays.com'),
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
  cron: {
    enabled: env.bool('CRON_ENABLED', true),
    tasks: require('../src/cron/tat-updater'),
  },
});
