#!/usr/bin/env node
/**
 * Test email with template and debug what variables are being sent
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

async function testTemplateEmail() {
    console.log('='.repeat(60));
    console.log('AutoSend Template Variable Test');
    console.log('='.repeat(60));
    console.log('');

    const apiKey = process.env.AUTOSEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM || 'noreply@serpbays.com';
    const templateId = process.env.AUTOSEND_TEMPLATE_ORDER_CREATED || 'A-887bd8e51845ac3ea25d';

    if (!apiKey) {
        console.error('❌ AUTOSEND_API_KEY not set in .env');
        process.exit(1);
    }

    try {
        const { Autosend } = require('autosendjs');
        const autosend = new Autosend(apiKey);

        const testEmail = process.env.TEST_EMAIL || 'vinayak@wordscloud.in';

        // Test variables matching the template
        const testVariables = {
            order_id: 12345,
            total_amount: 99.99,
            currency: 'USD',
            order_date: 'February 2, 2026',
            customer: 'Test Customer',
            item_1_name: 'Test Product',
            item_1_qty: 1,
            item_1_price: 99.99,
            subtotal: 99.99,
            taxes: 0
        };

        console.log('Sending to:', testEmail);
        console.log('Template ID:', templateId);
        console.log('Variables:', JSON.stringify(testVariables, null, 2));
        console.log('');

        const emailPayload = {
            from: {
                email: emailFrom
            },
            to: {
                email: testEmail
            },
            templateId: templateId,
            dynamicData: testVariables,
            tags: ['test', 'template-debug']
        };

        console.log('Full payload:', JSON.stringify(emailPayload, null, 2));
        console.log('');
        console.log('Sending email via AutoSend API...');

        const result = await autosend.emails.send(emailPayload);

        if (result.success) {
            console.log('');
            console.log('✅ EMAIL SENT SUCCESSFULLY!');
            console.log('='.repeat(60));
            console.log(`Email ID: ${result.data.emailId}`);
            console.log(`To: ${testEmail}`);
            console.log(`Template: ${templateId}`);
            console.log('');
            console.log('Check your inbox to verify variables appear correctly!');
            console.log('='.repeat(60));
        } else {
            console.error('❌ EMAIL SEND FAILED');
            console.error('Error:', result.error);
            console.error('Full result:', JSON.stringify(result, null, 2));
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testTemplateEmail();
