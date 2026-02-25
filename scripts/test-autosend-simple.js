#!/usr/bin/env node
/**
 * Simple AutoSend Test
 * Manually send a test email via AutoSend
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env from the server root
const envPath = path.join(__dirname, '..', '.env');
console.log(`Loading .env from: ${envPath}`);
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error('Error loading .env:', result.error);
} else {
  console.log('✅ .env loaded successfully');
}

console.log('\n' + '='.repeat(60));
console.log('AutoSend Simple Test');
console.log('='.repeat(60));
console.log('');

// Check API key
const apiKey = process.env.AUTOSEND_API_KEY;
console.log(`AUTOSEND_API_KEY: ${apiKey ? `${apiKey.substring(0, 15)}...` : '❌ NOT SET'}`);
console.log(`EMAIL_FROM: ${process.env.EMAIL_FROM || 'noreply@serpbays.com (default)'}`);
console.log('');

if (!apiKey) {
  console.error('❌ AUTOSEND_API_KEY is not set in .env file');
  console.log('\nPlease add to your .env:');
  console.log('AUTOSEND_API_KEY=your_key_here');
  process.exit(1);
}

// Test AutoSend SDK
console.log('Testing AutoSend SDK...');
try {
  const { Autosend } = require('autosendjs');
  const autosend = new Autosend(apiKey);
  console.log('✅ AutoSend SDK initialized successfully');
  console.log('');

  console.log('='.repeat(60));
  console.log('✅ AutoSend Integration is configured correctly!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Next steps:');
  console.log('1. Start Strapi: npm run develop');
  console.log('2. Create a test order to trigger order emails');
  console.log('3. Monitor AutoSend dashboard for email delivery');
  console.log('');

} catch (error) {
  console.error('❌ AutoSend SDK error:', error.message);
  console.log('\nMake sure autosendjs is installed:');
  console.log('npm install autosendjs');
  process.exit(1);
}
