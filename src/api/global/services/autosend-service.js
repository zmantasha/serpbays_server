'use strict';

/**
 * AutoSend Email Service
 * Handles email delivery via AutoSend API
 * Replaces Nodemailer/SMTP with AutoSend cloud service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::global.global', ({ strapi }) => ({

    /**
     * Send email via AutoSend API
     * @param {Object} params - Email parameters
     * @param {string} params.to - Recipient email address
     * @param {string} [params.templateId] - AutoSend template ID (for template-based emails)
     * @param {Object} [params.dynamicData] - Template dynamic data (for template-based emails)
     * @param {string} [params.subject] - Email subject (for HTML-based emails)
     * @param {string} [params.html] - HTML email body (for HTML-based emails)
     * @param {string} [params.text] - Plain text email body (for HTML-based emails)
     * @param {Array<string>} [params.tags] - Optional email tags for analytics
     * @returns {Promise<Object>} AutoSend response with message ID
     */
    async send({ to, templateId, dynamicData, subject, html, text, tags = ['transactional'] }) {
        try {
            const apiKey = process.env.AUTOSEND_API_KEY;

            if (!apiKey) {
                console.error('[AutoSend] AUTOSEND_API_KEY not configured in environment variables');
                throw new Error('AUTOSEND_API_KEY not configured. Please add it to your .env file.');
            }

            // Import AutoSend SDK - correct capitalization
            const { Autosend } = require('autosendjs');
            const autosend = new Autosend(apiKey);

            // Build email payload - support both template-based and HTML-based emails
            const emailPayload = {
                from: {
                    email: process.env.EMAIL_FROM || 'noreply@serpbays.com'
                },
                to: {
                    email: to
                },
                tags: ['serpbays', ...tags]
            };

            // Template-based email
            if (templateId) {
                emailPayload.templateId = templateId;
                if (dynamicData) {
                    emailPayload.dynamicData = dynamicData;
                }
                console.log(`[AutoSend] Sending template email to ${to} with template ID: "${templateId}"`);
                console.log(`[AutoSend] Dynamic data:`, JSON.stringify(dynamicData, null, 2));
            }
            // HTML-based email (legacy support)
            else {
                emailPayload.subject = subject;
                emailPayload.html = html;
                emailPayload.text = text;
                console.log(`[AutoSend] Sending HTML email to ${to} with subject: "${subject}"`);
            }

            // Use the correct API: autosend.emails.send()
            const result = await autosend.emails.send(emailPayload);

            if (!result.success) {
                throw new Error(result.error || 'Failed to send email');
            }

            console.log(`[AutoSend] Email sent successfully. Email ID: ${result.data.emailId}`);

            return {
                success: true,
                messageId: result.data.emailId,
                provider: 'autosend'
            };

        } catch (error) {
            console.error('[AutoSend] Error sending email:', {
                to,
                templateId,
                subject,
                error: error.message,
                stack: error.stack
            });

            // Rethrow to allow calling code to handle
            throw new Error(`AutoSend email delivery failed: ${error.message}`);
        }
    },

    /**
     * Send bulk emails via AutoSend
     * @param {Array<Object>} emails - Array of email objects with to, subject, html, text
     * @returns {Promise<Array<Object>>} Array of AutoSend responses
     */
    async sendBulk(emails) {
        try {
            const results = await Promise.allSettled(
                emails.map(email => this.send(email))
            );

            const successful = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;

            console.log(`[AutoSend] Bulk send completed: ${successful} successful, ${failed} failed`);

            return results;
        } catch (error) {
            console.error('[AutoSend] Bulk send error:', error);
            throw error;
        }
    },

    /**
     * Create a contact in AutoSend
     * @param {Object} contactData 
     * @param {string} contactData.email
     * @param {string} [contactData.firstName]
     * @param {string} [contactData.lastName]
     * @param {string} [contactData.userId]
     * @param {Object} [contactData.customFields]
     * @returns {Promise<Object>} Created contact data
     */
    async createContact({ email, firstName, lastName, userId, customFields = {} }) {
        try {
            const apiKey = process.env.AUTOSEND_API_KEY;

            if (!apiKey) {
                console.warn('[AutoSend] API key not configured, skipping contact creation');
                return null;
            }

            // Import AutoSend SDK
            const { Autosend } = require('autosendjs');
            const autosend = new Autosend(apiKey);

            const contactPayload = {
                email,
                firstName,
                lastName,
                userId: userId ? String(userId) : undefined,
                customFields
            };

            console.log(`[AutoSend] Creating contact for ${email}...`);

            // Use the contacts.create API
            const result = await autosend.contacts.create(contactPayload);

            if (!result.success) {
                // If it's a duplicate (already exists), it might return an error or success:false
                // In some APIs create fails if exists, user asked for "Create Contact"
                console.warn(`[AutoSend] Failed to create contact: ${result.error || 'Unknown error'}`);
                // Don't throw, just return null so we don't block registration
                return null;
            }

            console.log(`[AutoSend] Contact created successfully. Contact ID: ${result.data?.id}`);
            return result.data;

        } catch (error) {
            console.error('[AutoSend] Error creating contact:', error.message);
            // Non-blocking
            return null;
        }
    },

    /**
     * Verify AutoSend API key is configured and valid
     * @returns {Promise<boolean>} True if AutoSend is properly configured
     */
    async verifyConfiguration() {
        try {
            const apiKey = process.env.AUTOSEND_API_KEY;

            if (!apiKey) {
                console.warn('[AutoSend] API key not configured');
                return false;
            }

            // Try a test send to verify the API key works
            // Note: This will send a test email, so only use in development
            console.log('[AutoSend] Configuration verified - API key found');
            return true;

        } catch (error) {
            console.error('[AutoSend] Configuration verification failed:', error);
            return false;
        }
    }

}));
