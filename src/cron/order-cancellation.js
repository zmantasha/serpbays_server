'use strict';

/**
 * Order Cancellation Cron Job
 * Auto-cancels orders and sends warnings based on time limits
 */

module.exports = {
    // Run daily at 4 AM to handle order cancellations and warnings
    // Run daily at 4 AM to handle order cancellations and warnings
    '0 4 * * *': async ({ strapi }) => {
        console.log('Starting daily order cancellation & warning cron job...');

        try {
            const orderService = strapi.service('api::order.order');

            // 1. Auto-cancel PENDING orders older than 10 days
            const pendingDeadline = new Date();
            pendingDeadline.setDate(pendingDeadline.getDate() - 10);

            const pendingOrdersToCancel = await strapi.db.query('api::order.order').findMany({
                where: {
                    orderStatus: 'pending',
                    createdAt: { $lt: pendingDeadline } // Created before 10 days ago
                },
                populate: ['advertiser', 'publisher']
            });

            console.log(`Found ${pendingOrdersToCancel.length} pending orders to auto-cancel (older than 10 days)`);

            for (const order of pendingOrdersToCancel) {
                try {
                    console.log(`Auto-cancelling pending order #${order.id}`);

                    // Refund escrow
                    await orderService.refundEscrowToAdvertiser(order);

                    // Update order
                    await strapi.entityService.update('api::order.order', order.id, {
                        data: {
                            orderStatus: 'cancelled', // Fixed: Use valid enum
                            cancellationReason: 'Auto-cancelled: Not accepted within 10 days',
                            cancelledBy: 'system',
                            cancelledAt: new Date()
                        }
                    });

                    // Create audit log
                    await orderService.createAuditLog(order, 'cancelled', null, 'Auto-cancelled: Not accepted within 10 days');

                    // Send notifications
                    await orderService.sendCancellationNotifications(order, 'system', 'Auto-cancelled: Not accepted within 10 days');

                } catch (err) {
                    console.error(`Failed to auto-cancel pending order ${order.id}:`, err);
                }
            }

            // 2. Send Warning for ACCEPTED orders not delivered (30 days)
            const warningDeadline = new Date();
            warningDeadline.setDate(warningDeadline.getDate() - 30);

            // We need to check orders accepted before 30 days ago, that are still 'accepted' (not delivered/completed)
            // And specifically, we haven't sent a warning yet
            const ordersToWarn = await strapi.db.query('api::order.order').findMany({
                where: {
                    orderStatus: 'accepted',
                    acceptedDate: { $lt: warningDeadline },
                    warningNotificationSentAt: null // No warning sent yet
                },
                populate: ['publisher', 'advertiser']
            });

            console.log(`Found ${ordersToWarn.length} orders to warn (30 days w/o delivery)`);

            for (const order of ordersToWarn) {
                try {
                    // Send warning notification to PUBLISHER
                    if (order.publisher && order.publisher.email) {
                        await strapi.plugins['email'].services.email.send({
                            to: order.publisher.email,
                            from: process.env.EMAIL_FROM || 'no-reply@serpbays.com',
                            subject: `Urgent: Order #${order.id} Delivery Overdue`,
                            html: `
                <h2>Delivery Overdue Warning</h2>
                <p>Order #${order.id} was accepted over 30 days ago and has not been delivered.</p>
                <p>Please deliver this order immediately.</p>
                <p><strong>Warning:</strong> If not delivered within 15 days (45 days total), the order will be automatically cancelled and refunded.</p>
              `
                        });

                        // Update order to mark warning sent
                        await strapi.entityService.update('api::order.order', order.id, {
                            data: {
                                warningNotificationSentAt: new Date()
                            }
                        });

                        // Create audit log
                        await orderService.createAuditLog(order, 'warning_sent', null, '30 day non-delivery warning');

                        console.log(`Warning sent for order ${order.id}`);
                    }
                } catch (err) {
                    console.error(`Failed to warn for order ${order.id}:`, err);
                }
            }

            // 3. Auto-cancel ACCEPTED orders not delivered (45 days)
            const cancellationDeadline = new Date();
            cancellationDeadline.setDate(cancellationDeadline.getDate() - 45); // 45 days

            const ordersToCancelNonDelivery = await strapi.db.query('api::order.order').findMany({
                where: {
                    orderStatus: 'accepted',
                    acceptedDate: { $lt: cancellationDeadline }
                },
                populate: ['publisher', 'advertiser']
            });

            console.log(`Found ${ordersToCancelNonDelivery.length} orders to cancel for non-delivery (45 days)`);

            for (const order of ordersToCancelNonDelivery) {
                try {
                    console.log(`Auto-cancelling non-delivered order #${order.id}`);

                    // Refund escrow
                    await orderService.refundEscrowToAdvertiser(order);

                    // Update order
                    await strapi.entityService.update('api::order.order', order.id, {
                        data: {
                            orderStatus: 'cancelled', // Fixed: Use valid enum
                            cancellationReason: 'Auto-cancelled: Not delivered within 45 days',
                            cancelledBy: 'system',
                            cancelledAt: new Date()
                        }
                    });

                    // Create audit log
                    await orderService.createAuditLog(order, 'cancelled', null, 'Auto-cancelled: Not delivered within 45 days');

                    // Send notifications
                    await orderService.sendCancellationNotifications(order, 'system', 'Auto-cancelled: Not delivered within 45 days');

                } catch (err) {
                    console.error(`Failed to auto-cancel non-delivered order ${order.id}:`, err);
                }
            }

        } catch (error) {
            console.error('Failed to run daily order cancellation cron job:', error);
        }
    }
};
