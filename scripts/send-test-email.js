#!/usr/bin/env node
/**
 * Test AutoSend by actually sending a real email
 * This will verify the entire email flow works
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

async function sendTestEmail() {
    console.log('='.repeat(60));
    console.log('AutoSend Live Email Test');
    console.log('='.repeat(60));
    console.log('');

    const apiKey = process.env.AUTOSEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM || 'noreply@serpbays.com';

    if (!apiKey) {
        console.error('❌ AUTOSEND_API_KEY not set in .env');
        process.exit(1);
    }

    try {
        const { Autosend } = require('autosendjs');
        const autosend = new Autosend(apiKey);

        // IMPORTANT: Change this to your email address to test!
        const testEmail = process.env.TEST_EMAIL || 'vinayak@wordscloud.in';

        console.log(`Sending test email to: ${testEmail}`);
        console.log('');

        const emailPayload = {
            from: {
                email: emailFrom
            },
            to: {
                email: testEmail
            },
            subject: 'Test Email from SerpBays - AutoSend Integration',
            html: `
        <h1>✅ AutoSend Integration Test</h1>
        <p>This is a test email sent from your SerpBays application using AutoSend.</p>
        <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
        <p>If you received this email, your AutoSend integration is working correctly!</p>
        <hr>
        <p style="color: #666; font-size: 12px;">
          This is an automated test email from SerpBays AutoSend integration.
        </p>
      `,
            text: `AutoSend Integration Test\n\nThis is a test email from SerpBays.\nTimestamp: ${new Date().toLocaleString()}\n\nIf you received this, AutoSend is working!`,
            tags: ['test', 'serpbays', 'integration-test']
        };

        console.log('Sending email via AutoSend API...');
        const result = await autosend.emails.send(emailPayload);

        if (result.success) {
            console.log('');
            console.log('✅ EMAIL SENT SUCCESSFULLY!');
            console.log('='.repeat(60));
            console.log(`Email ID: ${result.data.emailId}`);
            console.log(`To: ${testEmail}`);
            console.log(`Subject: ${emailPayload.subject}`);
            console.log('');
            console.log('Check your inbox for the test email!');
            console.log('Also check AutoSend dashboard: https://autosend.com/dashboard');
            console.log('='.repeat(60));
        } else {
            console.error('❌ EMAIL SEND FAILED');
            console.error('Error:', result.error);
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

sendTestEmail();
