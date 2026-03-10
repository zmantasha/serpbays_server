/**
 * Email Blocker Middleware
 * 
 * This middleware provides an additional safety layer to ensure that email addresses
 * and other sensitive user information never appear in API responses.
 * 
 * While privateAttributes in the schema should already handle this, this middleware
 * acts as a fail-safe for edge cases and provides logging for security auditing.
 */

module.exports = (config, { strapi }) => {
    return async (ctx, next) => {
        await next();

        // Skip for non-JSON responses
        if (!ctx.body || typeof ctx.body !== 'object') {
            return;
        }

        let removedCount = 0;

        /**
         * Recursively remove sensitive fields from any object
         * @param {*} obj - Object to sanitize
         * @param {string} path - Current path for logging (e.g., 'data.user.email')
         */
        const removeSensitiveFields = (obj, path = 'response') => {
            if (!obj || typeof obj !== 'object') {
                return;
            }

            // Handle arrays
            if (Array.isArray(obj)) {
                obj.forEach((item, index) => {
                    removeSensitiveFields(item, `${path}[${index}]`);
                });
                return;
            }

            // Sensitive fields to remove
            const sensitiveFields = [
                // User fields
                'email',
                'phoneNumber',
                'billingAddress',
                'registrationNumber',
                'vatGstNumber',
                'resetPasswordToken',
                'confirmationToken',
                'password',
                'provider',
                // Website-specific fields
                'publisherEmail',
                'websitePublisherEmail',
                'publisherName',
                'websitePublisherName',
                'gscRefreshToken',
                'reviewNotes',
                'changeRequests',
                'claimedFrom',
                // Invoice/Billing fields
                'billingName',
                'billingCity',
                'billingCountry',
                'billingPincode',
                'billingVatGst',
                // Withdrawal/Payment fields
                'details',
                'admin_notes',
                'adminNotes',
                'payment_notes',
                'denial_reason',
                'external_transaction_id',
                'payment_reference',
                'notes',
                // User identification in bank transfers
                'userEmail',
                'userName',
                // Marketplace flattened fields
                'publisher_name',
                'publisher_email'
            ];

            // Remove sensitive fields
            sensitiveFields.forEach(field => {
                if (obj.hasOwnProperty(field)) {
                    // Log removal in development for debugging
                    if (strapi.config.environment === 'development') {
                        strapi.log.debug(`[Privacy] Removed ${field} from ${path}`);
                    }
                    delete obj[field];
                    removedCount++;
                }
            });

            // Recursively process nested objects
            Object.keys(obj).forEach(key => {
                if (obj[key] && typeof obj[key] === 'object') {
                    removeSensitiveFields(obj[key], `${path}.${key}`);
                }
            });
        };

        // Apply sanitization to response body
        removeSensitiveFields(ctx.body);

        // Log security event if sensitive data was removed
        if (removedCount > 0 && strapi.config.environment === 'production') {
            strapi.log.info(`[Privacy] Removed ${removedCount} sensitive field(s) from API response`, {
                path: ctx.request.path,
                method: ctx.request.method,
                user: ctx.state.user?.id || 'anonymous'
            });
        }
    };
};
