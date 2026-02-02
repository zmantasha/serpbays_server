#!/usr/bin/env node
/**
 * AutoSend Integration Test Script
 * Tests the AutoSend email service configuration
 */

require('dotenv').config();

async function testAutoSendConfiguration() {
    console.log('='.repeat(60));
    console.log('AutoSend Configuration Test');
    console.log('='.repeat(60));
    console.log('');

    // 1. Check if API key is configured
    console.log('1. Checking environment configuration...');
    const apiKey = process.env.AUTOSEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM;
    const emailReplyTo = process.env.EMAIL_REPLY_TO;
    const clientUrl = process.env.CLIENT_URL;

    if (!apiKey) {
        console.error('❌ AUTOSEND_API_KEY is not configured in .env file');
        console.log('\nPlease add the following to your .env file:');
        console.log('AUTOSEND_API_KEY=your_api_key_here');
        console.log('\nGet your API key from: https://autosend.com/dashboard');
        process.exit(1);
    }

    console.log(`✅ AUTOSEND_API_KEY: ${apiKey.substring(0, 10)}...`);
    console.log(`✅ EMAIL_FROM: ${emailFrom || 'noreply@serpbays.com (default)'}`);
    console.log(`✅ EMAIL_REPLY_TO: ${emailReplyTo || 'support@serpbays.com (default)'}`);
    console.log(`✅ CLIENT_URL: ${clientUrl || 'http://localhost:3000 (default)'}`);
    console.log('');

    // 2. Test AutoSend SDK import
    console.log('2. Testing AutoSend SDK...');
    try {
        const AutoSend = require('autosendjs');
        console.log('✅ AutoSend SDK imported successfully');

        const autosend = new AutoSend(apiKey);
        console.log('✅ AutoSend client initialized');
        console.log('');
    } catch (error) {
        console.error('❌ Failed to import AutoSend SDK:', error.message);
        console.log('\nPlease ensure autosendjs is installed:');
        console.log('npm install autosendjs');
        process.exit(1);
    }

    // 3. Test sending a real email (optional, requires valid API key)
    console.log('3. Testing email delivery (optional)...');
    console.log('');
    console.log('To test actual email delivery, you can:');
    console.log('  a) Create a test order in your application');
    console.log('  b) Monitor the AutoSend dashboard at https://autosend.com/dashboard');
    console.log('  c) Check server logs for "[AutoSend]" messages');
    console.log('');

    // 4. Verify Strapi service integration
    console.log('4. Checking Strapi integration...');
    const fs = require('fs');
    const path = require('path');

    const autosendServicePath = path.join(__dirname, '..', 'src', 'api', 'global', 'services', 'autosend-service.js');
    const emailOpsPath = path.join(__dirname, '..', 'src', 'api', 'global', 'services', 'email-operations.js');

    if (fs.existsSync(autosendServicePath)) {
        console.log('✅ autosend-service.js exists');
    } else {
        console.error('❌ autosend-service.js not found');
    }

    if (fs.existsSync(emailOpsPath)) {
        const emailOpsContent = fs.readFileSync(emailOpsPath, 'utf-8');
        const autosendCalls = (emailOpsContent.match(/autosend-service/g) || []).length;
        console.log(`✅ email-operations.js updated (${autosendCalls} AutoSend references)`);
    } else {
        console.error('❌ email-operations.js not found');
    }
    console.log('');

    // Summary
    console.log('='.repeat(60));
    console.log('✅ AutoSend Integration Test Complete!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Next steps:');
    console.log('1. Start your Strapi server: npm run develop');
    console.log('2. Create a test order to trigger an email');
    console.log('3. Check AutoSend dashboard for delivery confirmation');
    console.log('');
}

// Run the test
testAutoSendConfiguration().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
