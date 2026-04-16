'use strict';

/**
 * Auto-Approval Cron Job
 * Auto-approves delivered orders 96 hours after delivery if the advertiser hasn't acted.
 * Reuses the existing completeOrder() service for atomic escrow release.
 */

module.exports = {
  // Run every 6 hours to catch orders promptly after their 96-hour window
  '0 */6 * * *': async ({ strapi }) => {
    console.log('[AUTO-APPROVAL] Starting auto-approval cron job...');

    try {
      const now = new Date();

      // Find delivered orders past their auto-approval deadline
      const ordersToAutoApprove = await strapi.db.query('api::order.order').findMany({
        where: {
          orderStatus: 'delivered',
          autoApproveAt: {
            $lte: now,
            $ne: null
          }
        },
        populate: ['advertiser', 'publisher']
      });

      console.log(`[AUTO-APPROVAL] Found ${ordersToAutoApprove.length} orders to auto-approve`);

      let successCount = 0;
      let failCount = 0;

      for (const order of ordersToAutoApprove) {
        try {
          console.log(`[AUTO-APPROVAL] Processing order #${order.id} (delivered: ${order.deliveredDate}, deadline: ${order.autoApproveAt})`);

          // Reuse existing completeOrder() — handles escrow release, wallet credit, fee transaction, status update atomically
          await strapi.service('api::order.order').completeOrder(order.id, null);

          // Create audit log for the auto-approval
          await strapi.service('api::order.order').createAuditLog(
            order,
            'auto_approved',
            null,
            'Auto-approved: Advertiser did not respond within 96 hours of delivery'
          );

          // Send notifications to publisher (order completed + payment received)
          const publisherId = order.publisher?.id || order.publisher;
          const advertiserId = order.advertiser?.id || order.advertiser;

          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              order.id,
              publisherId,
              advertiserId,
              'order_completed'
            );
          } catch (notifErr) {
            console.error(`[AUTO-APPROVAL] Failed to create order notification for order #${order.id}:`, notifErr);
          }

          try {
            await strapi.service('api::notification.notification').createPaymentNotification(
              publisherId,
              'payment_received',
              order.totalAmount
            );
          } catch (notifErr) {
            console.error(`[AUTO-APPROVAL] Failed to create payment notification for order #${order.id}:`, notifErr);
          }

          // Send emails
          try {
            const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
              where: { id: publisherId }
            });
            const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
              where: { id: advertiserId }
            });

            const emailService = strapi.service('api::global.email-operations');

            // Publisher gets the standard completion email
            if (publisherUser?.email) {
              await emailService.sendOrderCompletionEmail(order, publisherUser.email, order.totalAmount);
            }

            // Advertiser gets a specific auto-approval notification
            if (advertiserUser?.email) {
              await emailService.sendAutoApprovalEmail(order, advertiserUser.email, order.totalAmount);
            }
          } catch (emailErr) {
            console.error(`[AUTO-APPROVAL] Failed to send emails for order #${order.id}:`, emailErr);
          }

          successCount++;
          console.log(`[AUTO-APPROVAL] Successfully auto-approved order #${order.id}`);

        } catch (err) {
          failCount++;
          console.error(`[AUTO-APPROVAL] Failed to auto-approve order #${order.id}:`, err);
        }
      }

      console.log(`[AUTO-APPROVAL] Completed. Success: ${successCount}, Failed: ${failCount}`);

    } catch (error) {
      console.error('[AUTO-APPROVAL] Cron job failed:', error);
    }
  }
};
