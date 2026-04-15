'use strict';

/**
 * Order Auto-Approve Cron Job
 *
 * Auto-completes delivered orders that the advertiser has not approved
 * within the configured number of days (global-config.autoApproveDays,
 * default 5). Reuses the existing orderService.completeOrder() method
 * which handles escrow release, publisher payment, and status update
 * inside a DB transaction.
 *
 * Runs daily at 3 AM — after TAT updater (2 AM) and before
 * order-cancellation (4 AM).
 */

module.exports = {
    '0 3 * * *': async ({ strapi }) => {
        console.log('[Auto-Approve] Starting daily auto-approve cron job...');

        try {
            // Read the configurable threshold from global-config (default 5 days)
            let autoApproveDays = 5;
            try {
                const globalConfig = await strapi.db.query('api::global-config.global-config').findOne({});
                if (globalConfig && globalConfig.autoApproveDays) {
                    autoApproveDays = globalConfig.autoApproveDays;
                }
            } catch (configErr) {
                console.warn('[Auto-Approve] Could not read global-config, using default 5 days');
            }

            const deadline = new Date();
            deadline.setDate(deadline.getDate() - autoApproveDays);

            const ordersToApprove = await strapi.db.query('api::order.order').findMany({
                where: {
                    orderStatus: 'delivered',
                    deliveredDate: { $lt: deadline }
                },
                populate: ['advertiser', 'publisher']
            });

            console.log(`[Auto-Approve] Found ${ordersToApprove.length} delivered orders older than ${autoApproveDays} days`);

            if (ordersToApprove.length === 0) return;

            const orderService = strapi.service('api::order.order');
            const emailService = strapi.service('api::global.email-operations');
            const notificationService = strapi.service('api::notification.notification');

            let completed = 0;
            let failed = 0;

            for (const order of ordersToApprove) {
                try {
                    console.log(`[Auto-Approve] Completing order #${order.id} (delivered ${order.deliveredDate})`);

                    // Reuse the existing completeOrder service — handles escrow
                    // release, publisher payment, fee transaction, status update,
                    // and TAT update, all inside a DB transaction.
                    await orderService.completeOrder(order.id, { id: order.advertiser?.id || order.advertiser });

                    // Audit log
                    await orderService.createAuditLog(
                        order, 'auto_approved', null,
                        `Auto-approved: advertiser did not act within ${autoApproveDays} days`
                    );

                    // Notifications (non-blocking — same pattern as the controller)
                    const publisherId = order.publisher?.id || order.publisher;
                    const advertiserId = order.advertiser?.id || order.advertiser;

                    try {
                        await notificationService.createOrderNotification(
                            order.id, publisherId, advertiserId, 'order_completed'
                        );
                    } catch (e) {
                        console.error(`[Auto-Approve] Notification failed for order #${order.id}:`, e.message);
                    }

                    try {
                        await notificationService.createPaymentNotification(
                            publisherId, 'payment_received', order.totalAmount
                        );
                    } catch (e) {
                        console.error(`[Auto-Approve] Payment notification failed for order #${order.id}:`, e.message);
                    }

                    // Email to publisher
                    try {
                        const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
                            where: { id: publisherId }
                        });
                        if (publisherUser?.email) {
                            await emailService.sendOrderCompletionEmail(order, publisherUser.email, order.totalAmount);
                        }
                    } catch (e) {
                        console.error(`[Auto-Approve] Email failed for order #${order.id}:`, e.message);
                    }

                    completed++;
                    console.log(`[Auto-Approve] Order #${order.id} completed successfully`);
                } catch (err) {
                    failed++;
                    console.error(`[Auto-Approve] Failed to complete order #${order.id}:`, err.message);
                }
            }

            console.log(`[Auto-Approve] Done. Completed: ${completed}, Failed: ${failed}`);
        } catch (error) {
            console.error('[Auto-Approve] Cron job failed:', error);
        }
    }
};
