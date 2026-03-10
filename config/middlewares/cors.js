module.exports = {
  cors: {
    enabled: true,
    headers: [
      'Content-Type',
      'Authorization',
      'X-Frame-Options',
      'Accept',
      'Origin'
    ],
    origin: [
      process.env.CLIENT_URL || 'http://localhost:3000',
      'http://localhost:1337',
      'http://localhost:3800',
      'http://staging.serpbays.com',
      'https://staging.serpbays.com',
      'https://cms.serpbays.com',
      'http://localhost:3009'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    keepHeaderOnError: true,
    maxAge: 86400
  }
}; 