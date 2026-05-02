'use strict';

/**
 * Autosend Marketing Lists Cron Job
 *
 * Runs once per day to add inactive users to the Autosend mailing list.
 * Targets users who signed up exactly 3 days ago, so each user is
 * only processed ONCE (not repeatedly on every run).
 */

module.exports = {
    /**
     * Inactive After Signup — runs once daily at midnight
     * Targets users who signed up exactly 3 days ago (within a 24hr window)
     */
    autosendInactiveSignupSync: {
        task: async ({ strapi }) => {
            const listId = process.env.AUTOSEND_INACTIVE_SIGNUP_LIST_ID;
            if (!listId) return;

            console.log('[AutoSend Cron] Running inactive-signup list sync...');

            try {
                const autoSendService = strapi.service('api::global.autosend-service');
                if (!autoSendService) return;

                const now = new Date();
                // Target users who signed up exactly 3 days ago (within a 24hr window)
                // e.g., if today is March 5th, find users created on March 2nd
                const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
                const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000);

                const candidates = await strapi.db.query('plugin::users-permissions.user').findMany({
                    where: {
                        createdAt: {
                            $gte: fourDaysAgo,   // created after 4 days ago
                            $lte: threeDaysAgo,  // created before 3 days ago
                        },
                        confirmed: true,
                    },
                    select: ['id', 'email', 'createdAt'],
                });

                console.log(`[AutoSend Cron] Found ${candidates.length} users who signed up 3 days ago`);

                let added = 0;
                let skipped = 0;

                for (const user of candidates) {
                    try {
                        // Check: zero non-cancelled advertiser orders
                        const orderCount = await strapi.db.query('api::order.order').count({
                            where: {
                                advertiser: user.id,
                                orderStatus: { $ne: 'cancelled' },
                            },
                        });

                        if (orderCount > 0) {
                            skipped++;
                            continue;
                        }

                        // All conditions met — add to inactive signup list
                        await autoSendService.addToList({ email: user.email, listId });
                        added++;

                    } catch (userErr) {
                        console.error(`[AutoSend Cron] Error processing user ${user.email}:`, userErr.message);
                    }
                }

                console.log(`[AutoSend Cron] Inactive signup sync complete: ${added} added, ${skipped} skipped`);

            } catch (err) {
                console.error('[AutoSend Cron] Inactive signup sync failed:', err.message);
            }
        },
        options: {
            rule: '0 0 * * *', // Once daily at midnight
        },
    },

    /**
     * Win-Back Churned Buyers — runs once daily at 1 AM
     * Targets users whose last order was exactly 30 days ago (24hr window)
     * so each user is processed once
     */
    autosendWinBackSync: {
        task: async ({ strapi }) => {
            const listId = process.env.AUTOSEND_WINBACK_LIST_ID;
            if (!listId) return;

            console.log('[AutoSend Cron] Running win-back churned buyers sync...');

            try {
                const autoSendService = strapi.service('api::global.autosend-service');
                if (!autoSendService) return;

                const now = new Date();
                const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
                const thirtyOneDaysAgo = new Date(now - 31 * 24 * 60 * 60 * 1000);

                // Find all users who have placed at least one non-cancelled order
                // We'll then check if their LAST order falls in the 30-day window
                const usersWithOrders = await strapi.db.query('plugin::users-permissions.user').findMany({
                    where: { confirmed: true },
                    select: ['id', 'email'],
                });

                console.log(`[AutoSend Cron] Checking ${usersWithOrders.length} users for churn`);

                let added = 0;
                let skipped = 0;

                for (const user of usersWithOrders) {
                    try {
                        // Find user's most recent non-cancelled order
                        const latestOrder = await strapi.db.query('api::order.order').findOne({
                            where: {
                                advertiser: user.id,
                                orderStatus: { $ne: 'cancelled' },
                            },
                            orderBy: { createdAt: 'desc' },
                            select: ['id', 'createdAt'],
                        });

                        if (!latestOrder) {
                            skipped++; // never ordered, skip
                            continue;
                        }

                        const lastOrderDate = new Date(latestOrder.createdAt);

                        // Check: was their last order exactly 30 days ago? (24hr window)
                        if (lastOrderDate >= thirtyOneDaysAgo && lastOrderDate <= thirtyDaysAgo) {
                            await autoSendService.addToList({ email: user.email, listId });
                            added++;
                        } else {
                            skipped++;
                        }

                    } catch (userErr) {
                        console.error(`[AutoSend Cron] Error processing user ${user.email}:`, userErr.message);
                    }
                }

                console.log(`[AutoSend Cron] Win-back sync complete: ${added} added, ${skipped} skipped`);

            } catch (err) {
                console.error('[AutoSend Cron] Win-back sync failed:', err.message);
            }
        },
        options: {
            rule: '0 1 * * *', // Once daily at 1 AM
        },
    },

    /**
     * Biweekly New Websites Newsletter — runs every other Monday at 9 AM
     * Sends top 5 new high-DA websites to all confirmed users
     * Controlled by `newsletterEnabled` toggle in Global Config (Strapi admin)
     */
    autosendNewWebsitesNewsletter: {
        task: async ({ strapi }) => {
            const templateId = process.env.AUTOSEND_TEMPLATE_NEWSLETTER;
            const unsubscribeGroupId = process.env.AUTOSEND_NEWSLETTER_UNSUBSCRIBE_GROUP;
            if (!templateId) {
                console.log('[AutoSend Cron] Newsletter template not configured, skipping');
                return;
            }

            console.log('[AutoSend Cron] Checking if newsletter is enabled...');

            try {
                // Check the admin toggle in Global Config (singleType — only one record)
                const config = await strapi.db.query('api::global-config.global-config').findOne({});

                if (!config || !config.newsletterEnabled) {
                    console.log('[AutoSend Cron] Newsletter is DISABLED in Global Config, skipping');
                    return;
                }

                console.log('[AutoSend Cron] Newsletter is ENABLED, preparing to send...');

                const autoSendService = strapi.service('api::global.autosend-service');
                if (!autoSendService) return;

                // Get websites added in the last 15 days, sorted by DA (highest first)
                const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

                const newWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
                    where: {
                        createdAt: { $gte: fifteenDaysAgo },
                        publishedAt: { $notNull: true },
                    },
                    orderBy: { moz_da: 'desc' },
                    limit: 5,
                    select: ['id', 'url', 'moz_da', 'ahrefs_dr', 'price', 'category', 'ahrefs_traffic'],
                });

                if (newWebsites.length === 0) {
                    console.log('[AutoSend Cron] No new websites in the last 15 days, skipping newsletter');
                    return;
                }

                // Build dynamic data for template
                const dynamicData = {
                    totalNewWebsites: newWebsites.length.toString(),
                };

                // Add each website as template variables
                newWebsites.forEach((site, index) => {
                    const num = index + 1;
                    dynamicData[`website_${num}_url`] = site.url || '';
                    dynamicData[`website_${num}_da`] = (site.moz_da || 0).toString();
                    dynamicData[`website_${num}_dr`] = (site.ahrefs_dr || 0).toString();
                    dynamicData[`website_${num}_price`] = `$${site.price || 0}`;
                    dynamicData[`website_${num}_category`] = site.category || 'General';
                    dynamicData[`website_${num}_traffic`] = (site.ahrefs_traffic || 0).toLocaleString();
                });

                // Pad remaining slots if fewer than 5 websites
                for (let i = newWebsites.length + 1; i <= 5; i++) {
                    dynamicData[`website_${i}_url`] = '';
                    dynamicData[`website_${i}_da`] = '';
                    dynamicData[`website_${i}_dr`] = '';
                    dynamicData[`website_${i}_price`] = '';
                    dynamicData[`website_${i}_category`] = '';
                    dynamicData[`website_${i}_traffic`] = '';
                }

                console.log(`[AutoSend Cron] Featuring ${newWebsites.length} new websites in newsletter`);

                // Get all confirmed users
                const users = await strapi.db.query('plugin::users-permissions.user').findMany({
                    where: { confirmed: true },
                    select: ['id', 'email', 'firstName'],
                });

                console.log(`[AutoSend Cron] Sending newsletter to ${users.length} users...`);

                const recipients = users.map(u => ({
                    email: u.email,
                    firstName: u.firstName || '',
                }));

                const result = await autoSendService.sendNewsletter({
                    templateId,
                    dynamicData,
                    recipients,
                    unsubscribeGroupId,
                });

                console.log(`[AutoSend Cron] Newsletter sent: ${result.sent} delivered, ${result.failed} failed`);

            } catch (err) {
                console.error('[AutoSend Cron] Newsletter send failed:', err.message);
            }
        },
        options: {
            rule: '0 9 */15 * 1', // Every other Monday at 9 AM (approx. biweekly)
        },
    },
};
