'use strict';

/**
 * Email Operations Service
 * Handles all project operations via email including:
 * - Accepting payments
 * - Creating orders
 * - Delivering orders
 * - Completing orders
 * - Making transactions
 * - Denying transactions
 * - Marking transactions as paid
 */

const { createCoreService } = require('@strapi/strapi').factories;

// Format an order status value for display in subject lines and the status
// chip in transactional emails: title-cases each underscore-separated word
// (e.g. "revision_requested" -> "Revision Requested", "accepted" -> "Accepted").
const formatOrderStatus = (status) => {
  if (!status || typeof status !== 'string') return status;
  return status
    .split('_')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
};

module.exports = createCoreService('api::global.global', ({ strapi }) => ({

  /**
   * Send payment acceptance email to advertiser
   */
  async sendPaymentAcceptanceEmail(orderId, amount, userEmail) {
    try {
      const emailData = {
        to: userEmail,
        subject: `Payment Required - Order #${orderId} - $${amount}`,
        html: this.generatePaymentAcceptanceTemplate(orderId, amount),
        text: `Payment of $${amount} is required for Order #${orderId}. Reply with CONFIRM-PAYMENT-${orderId} to proceed.`
      };

      const emailResult = await strapi.service('api::global.autosend-service').send(emailData);
      return emailResult;
    } catch (error) {
      console.error('Error sending payment acceptance email:', error);
      throw error;
    }
  },

  /**
   * Send order creation confirmation email using AutoSend template
   */
  async sendOrderCreationEmail(order, publisherEmail, advertiserEmail) {
    try {
      console.log(`[EMAIL DEBUG] sendOrderCreationEmail called for order ${order.id}`);
      console.log(`[EMAIL DEBUG] Publisher email: ${publisherEmail}`);
      console.log(`[EMAIL DEBUG] Advertiser email: ${advertiserEmail}`);
      console.log(`[EMAIL DEBUG] Order website: ${order.website?.url || 'N/A'}`);

      // Email to publisher using universal AutoSend template
      const publisherEmailData = {
        to: publisherEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Order details - using snake_case to match AutoSend template
          order_id: order.id,
          order_status: formatOrderStatus('created'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',

          // User details
          publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: order.advertiser?.username || order.advertiser?.email || 'Advertiser',
          customer: order.advertiser?.username || order.advertiser?.email || 'Advertiser',

          // Website details
          website_name: order.website?.name || order.website?.url || 'Website',
          website_url: order.website?.url || '',

          // Item details for template
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/publisher/available-orders`,
          dashboard_url: `${process.env.CLIENT_URL}/publisher/my-orders`,
          publisher_new_orders_url: `${process.env.CLIENT_URL}/publisher/available-orders`,

          // Lets the AutoSend template render the publisher-only
          // "Accept Order" CTA. Intentionally set only here so the block
          // appears on the first email a publisher receives for an order
          // and not on later status updates (cancellation, revision, etc.).
          is_new_order_for_publisher: true,

          // Timestamp
          order_date: new Date(order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })
        },
        tags: ['order', 'order-created', 'publisher']
      };

      console.log(`[EMAIL DEBUG] About to send email to: ${publisherEmail}`);
      await strapi.service('api::global.autosend-service').send(publisherEmailData);
      console.log(`[EMAIL DEBUG] Email successfully sent to ${publisherEmail} for order ${order.id}`);

      console.log(`Order creation email sent for order ${order.id} to ${publisherEmail}`);
    } catch (error) {
      console.error('Error sending order creation email:', error);
      throw error;
    }
  },

  /**
   * Send order rejection notification email using universal template
   */
  async sendOrderRejectionEmail(order, advertiserEmail, publisherEmail) {
    try {
      console.log(`[EMAIL DEBUG] sendOrderRejectionEmail called for order ${order.id}`);

      const advertiserName = order.advertiser?.username || order.advertiser?.email || 'there';

      // Email to advertiser using universal template
      const advertiserEmailData = {
        to: advertiserEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Core order details
          order_id: order.id,
          order_status: formatOrderStatus('rejected'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_date: new Date(order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Website details
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || 'Website',

          // The AutoSend universal template greets with {{publisher_name}};
          // for advertiser-bound mail we override it to the advertiser's name
          // so the greeting reads correctly. Publisher's real name lives in
          // real_publisher_name.
          publisher_name: advertiserName,
          real_publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: advertiserName,
          customer: advertiserName,
          recipient_name: advertiserName,

          // Item details
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/orders/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/orders`,

          // Rejection-specific conditional fields (shown in template)
          order_cancel_reason: order.rejectionReason || 'No reason provided',
          amount_refunded: order.totalAmount || 0,

          // Other conditional fields - not shown for rejection
          // revision_request_description: undefined
          // delivery_proof_url: undefined
          // delivery_message: undefined
        },
        tags: ['order', 'order-rejected', 'advertiser']
      };

      await strapi.service('api::global.autosend-service').send(advertiserEmailData);
      console.log(`Order rejection email sent for order ${order.id} to ${advertiserEmail}`);
    } catch (error) {
      console.error('Error sending order rejection emails:', error);
      throw error;
    }
  },

  /**
   * Send order cancellation email using universal template
   */
  async sendOrderCancellationEmail(order, recipientEmail, cancelledBy, reason) {
    try {
      console.log(`[EMAIL DEBUG] sendOrderCancellationEmail called for order ${order.id}`);

      const publisherName = order.publisher?.username || order.publisher?.email || 'Publisher';
      const advertiserName = order.advertiser?.username || order.advertiser?.email || 'Advertiser';
      const isAdvertiserRecipient = recipientEmail && order.advertiser?.email && recipientEmail.toLowerCase() === order.advertiser.email.toLowerCase();
      const recipientName = isAdvertiserRecipient ? advertiserName : publisherName;

      const emailData = {
        to: recipientEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Core order details
          order_id: order.id,
          order_status: formatOrderStatus('cancelled'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_date: new Date(order.cancelledAt || order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Website details
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || 'Website',

          // The AutoSend universal template greets with {{publisher_name}};
          // override it to the recipient's actual name so the greeting reads
          // correctly. The real publisher's name stays available as
          // real_publisher_name for template references.
          publisher_name: recipientName,
          real_publisher_name: publisherName,
          advertiser_name: advertiserName,
          customer: recipientName,
          recipient_name: recipientName,

          // Item details
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/orders/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/orders`,

          // Cancellation-specific conditional fields (shown in template)
          order_cancel_reason: reason || order.cancellationReason || 'No reason provided',
          amount_refunded: order.totalAmount || 0,
          cancelled_by: cancelledBy || 'system',

          // Other conditional fields - not shown for cancellation
          // revision_request_description: undefined
          // delivery_proof_url: undefined
          // delivery_message: undefined
        },
        tags: ['order', 'order-cancelled', 'cancellation']
      };

      await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`Order cancellation email sent for order ${order.id} to ${recipientEmail}`);
    } catch (error) {
      console.error('Error sending order cancellation email:', error);
      throw error;
    }
  },

  /**
   * Send order acceptance notification email using universal template
   */
  async sendOrderAcceptanceEmail(order, advertiserEmail, publisherEmail) {
    try {
      console.log(`[EMAIL DEBUG] sendOrderAcceptanceEmail called for order ${order.id}`);

      const advertiserName = order.advertiser?.username || order.advertiser?.email || 'there';

      // Email to advertiser using universal template
      const advertiserEmailData = {
        to: advertiserEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Core order details
          order_id: order.id,
          order_status: formatOrderStatus('accepted'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_date: new Date(order.acceptedDate || order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Website details
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || 'Website',

          // The AutoSend universal template uses {{publisher_name}} for the
          // top-line greeting on every email — including those sent to the
          // advertiser. Setting publisher_name to the advertiser's name here
          // makes the greeting render correctly for advertiser-bound mail.
          // The publisher's real name is still available via real_publisher_name.
          publisher_name: advertiserName,
          real_publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: advertiserName,
          customer: advertiserName,
          recipient_name: advertiserName,

          // Item details
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/orders/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/orders`,

          // Conditional fields - not shown for acceptance
          // order_cancel_reason: undefined
          // amount_refunded: undefined  
          // revision_request_description: undefined
          // delivery_proof_url: undefined
          // delivery_message: undefined
        },
        tags: ['order', 'order-accepted', 'advertiser']
      };

      await strapi.service('api::global.autosend-service').send(advertiserEmailData);
      console.log(`Order acceptance email sent for order ${order.id} to ${advertiserEmail}`);
    } catch (error) {
      console.error('Error sending order acceptance emails:', error);
      throw error;
    }
  },

  /**
   * Send revision request notification email using universal template
   */
  async sendRevisionRequestEmail(order, publisherEmail, advertiserEmail) {
    try {
      console.log(`[EMAIL DEBUG] sendRevisionRequestEmail called for order ${order.id}`);

      // Email to publisher using universal template
      const publisherEmailData = {
        to: publisherEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Core order details
          order_id: order.id,
          order_status: formatOrderStatus('revision_requested'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_date: new Date(order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Website details
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || 'Website',

          // User details
          publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: order.advertiser?.username || order.advertiser?.email || 'Advertiser',
          customer: order.advertiser?.username || order.advertiser?.email || 'Advertiser',

          // Item details
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/publisher/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/publisher/my-orders`,

          // Revision-specific conditional field (shown in template)
          revision_request_description: order.revisionMessage || 'No revision details provided',

          // Other conditional fields - not shown for revision
          // order_cancel_reason: undefined
          // amount_refunded: undefined
          // delivery_proof_url: undefined
          // delivery_message: undefined
        },
        tags: ['order', 'revision-requested', 'publisher']
      };

      await strapi.service('api::global.autosend-service').send(publisherEmailData);
      console.log(`Revision request email sent for order ${order.id} to ${publisherEmail}`);
    } catch (error) {
      console.error('Error sending revision request emails:', error);
      throw error;
    }
  },

  /**
   * Send order delivery notification email using universal template
   */
  async sendOrderDeliveryEmail(order, advertiserEmail, publisherEmail) {
    try {
      console.log(`[EMAIL DEBUG] sendOrderDeliveryEmail called for order ${order.id}`);

      const advertiserName = order.advertiser?.username || order.advertiser?.email || 'there';

      // Email to advertiser using universal template
      const advertiserEmailData = {
        to: advertiserEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Core order details
          order_id: order.id,
          order_status: formatOrderStatus('delivered'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_date: new Date(order.deliveredDate || order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Website details
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || 'Website',

          // The AutoSend universal template greets with {{publisher_name}};
          // for advertiser-bound mail we override it to the advertiser's name
          // so the greeting reads correctly. Publisher's real name lives in
          // real_publisher_name.
          publisher_name: advertiserName,
          real_publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: advertiserName,
          customer: advertiserName,
          recipient_name: advertiserName,

          // Item details
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/orders/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/orders`,

          // Delivery-specific conditional fields (shown in template)
          delivery_proof_url: order.deliveryProof || '',
          delivery_message: order.deliveryMessage || '',

          // Other conditional fields - not shown for delivery
          // order_cancel_reason: undefined
          // amount_refunded: undefined
          // revision_request_description: undefined
        },
        tags: ['order', 'order-delivered', 'advertiser']
      };

      await strapi.service('api::global.autosend-service').send(advertiserEmailData);
      console.log(`Order delivery email sent for order ${order.id} to ${advertiserEmail}`);
    } catch (error) {
      console.error('Error sending order delivery emails:', error);
      throw error;
    }
  },

  /**
   * Send order completion email with payment release using universal template
   */
  async sendOrderCompletionEmail(order, publisherEmail, amount) {
    try {
      console.log(`[EMAIL DEBUG] sendOrderCompletionEmail called for order ${order.id}`);

      // Email to publisher using universal template
      const emailData = {
        to: publisherEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          // Core order details
          order_id: order.id,
          order_status: formatOrderStatus('completed'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_date: new Date(order.completedDate || order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Website details
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || 'Website',

          // User details
          publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: order.advertiser?.username || order.advertiser?.email || 'Advertiser',
          customer: order.advertiser?.username || order.advertiser?.email || 'Advertiser',

          // Item details
          item_1_name: order.website?.name || 'Order Service',
          item_1_qty: 1,
          item_1_price: order.totalAmount || 0,
          subtotal: order.totalAmount || 0,
          taxes: 0,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/publisher/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/publisher/my-orders`,

          // Payment info
          payment_amount: amount || order.totalAmount || 0,

          // Conditional fields - not shown for completion
          // order_cancel_reason: undefined
          // amount_refunded: undefined
          // revision_request_description: undefined
          // delivery_proof_url: undefined
          // delivery_message: undefined
        },
        tags: ['order', 'order-completed', 'publisher']
      };

      await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`Order completion email sent for order ${order.id} to ${publisherEmail}`);
    } catch (error) {
      console.error('Error sending order completion email:', error);
      throw error;
    }
  },

  // ============================================
  // TRANSACTION EMAIL FUNCTIONS
  // ============================================

  /**
   * Central dispatcher for all transaction emails.
   * Uses template A-fec3e40871b864b733af with is_* flags to pick the right block.
   * Guards against duplicate sends per (transaction, statusLabel) via metadata.emails_sent,
   * and respects TRANSACTION_EMAILS_ENABLED (defaults on in production, off in dev/test).
   */
  async sendTransactionEmail({ transaction, userEmail, statusLabel, statusMessage, notes, flags = {}, extra = {}, tags }) {
    if (!transaction || !transaction.id) {
      console.warn('[EMAIL] sendTransactionEmail called without a transaction; skipping.');
      return { skipped: true, reason: 'no_transaction' };
    }

    const explicit = process.env.TRANSACTION_EMAILS_ENABLED;
    const enabled = explicit === 'true' || (explicit === undefined && process.env.NODE_ENV === 'production');
    if (!enabled) {
      console.log(`[EMAIL] Transaction email suppressed for tx ${transaction.id} (TRANSACTION_EMAILS_ENABLED not on).`);
      return { skipped: true, reason: 'env_disabled' };
    }

    if (!userEmail) {
      console.warn(`[EMAIL] No recipient email for tx ${transaction.id}; skipping.`);
      return { skipped: true, reason: 'no_recipient' };
    }

    const meta = transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {};
    const emailsSent = Array.isArray(meta.emails_sent) ? meta.emails_sent : [];
    if (emailsSent.includes(statusLabel)) {
      console.log(`[EMAIL] Duplicate ${statusLabel} email for tx ${transaction.id} blocked.`);
      return { skipped: true, reason: 'already_sent' };
    }

    const clientUrl = process.env.CLIENT_URL || '';
    // Explicit booleans (not undefined) so the AutoSend template's {{#if}}
    // checks can actually hide non-applicable sections — leaving these unset
    // caused the Earnings block to render on withdrawal emails.
    const isEarning = flags.is_earning === true;
    const isWithdrawal = flags.is_withdrawal === true;
    const isWalletCredit = flags.is_wallet_credit === true;
    const isPaymentFailed = flags.is_payment_failed === true;
    const isBonus = flags.is_bonus === true;

    // For withdrawal emails, show the user's net payout (what they actually
    // receive) — never the gross amount that includes the internal platform
    // fee. The "amount" field on the transaction stores the gross deduction;
    // "netAmount" stores the payout. Falling back to amount only when
    // netAmount is unavailable keeps non-withdrawal flows untouched.
    const displayAmount = isWithdrawal
      ? (transaction.netAmount != null ? transaction.netAmount : transaction.amount || 0)
      : (transaction.amount || 0);

    const dynamicData = {
      transaction_id: transaction.id,
      transaction_status: statusLabel,
      transaction_type: transaction.type || 'payment',
      amount: displayAmount,
      payment_gateway: transaction.gateway || 'system',
      gateway_transaction_id: transaction.gatewayTransactionId || '',
      // For withdrawals, never fall back to transaction.description — it
      // contains internal accounting ("$X payout + $Y platform fee") that
      // shouldn't be exposed to the user. Other transaction types may safely
      // use the description as a notes default.
      notes: notes || (isWithdrawal ? '' : transaction.description || ''),
      status_message: statusMessage || '',

      is_earning: isEarning,
      is_withdrawal: isWithdrawal,
      is_wallet_credit: isWalletCredit,
      is_payment_failed: isPaymentFailed,
      is_bonus: isBonus,

      // Section-specific defaults so the universal template never renders
      // empty labels (e.g. "Order ID:" with nothing after it for a withdrawal).
      order_id: '',
      publisher_website: '',
      withdrawal_status: isWithdrawal ? statusLabel : '',
      // The template references {{timeline}}; estimated_timeline kept as an
      // alias in case the template (or a future revision) reads either.
      timeline: '',
      estimated_timeline: '',

      // The template's "View Transaction" button binds to {{transaction_url}};
      // view_transaction_url is kept as an alias for any other consumer.
      // The client app shows transactions inside the /wallet page (there is
      // no separate /wallet/transactions route), so link there.
      transaction_url: `${clientUrl}/wallet`,
      view_transaction_url: `${clientUrl}/wallet`,
      view_wallet_url: `${clientUrl}/wallet`,
      // There is no in-app /support page; use a mailto so the link works in
      // every mail client. SUPPORT_EMAIL overrides the default.
      support_url: `mailto:${process.env.SUPPORT_EMAIL || 'support@serpbays.com'}`,

      ...extra,
    };

    // Back-compat: callers historically passed `withdrawal_timeline` in `extra`.
    // The template's "Estimated Timeline" field reads {{timeline}}, so mirror
    // the legacy key onto both timeline aliases when only the legacy value
    // was supplied.
    const legacyTimeline = dynamicData.withdrawal_timeline;
    if (legacyTimeline) {
      if (!extra.timeline) dynamicData.timeline = legacyTimeline;
      if (!extra.estimated_timeline) dynamicData.estimated_timeline = legacyTimeline;
    }

    // Route to a purpose-specific template when one is configured. AutoSend
    // templates don't support conditional sections, so the "universal"
    // template renders every block (Earnings, Withdrawal, Wallet, ...) on
    // every email. To avoid an Earnings card appearing on a withdrawal mail
    // (and vice versa), each scenario should point at a template that only
    // contains its own blocks. Falls back to the universal template when a
    // scenario-specific one isn't configured.
    const universalTemplateId = process.env.AUTOSEND_TEMPLATE_TRANSACTION_UNIVERSAL || 'A-fec3e40871b864b733af';
    const templateId =
      (isEarning && process.env.AUTOSEND_TEMPLATE_TRANSACTION_EARNING) ||
      (isWithdrawal && process.env.AUTOSEND_TEMPLATE_TRANSACTION_WITHDRAWAL) ||
      (isWalletCredit && process.env.AUTOSEND_TEMPLATE_TRANSACTION_WALLET) ||
      (isPaymentFailed && process.env.AUTOSEND_TEMPLATE_TRANSACTION_FAILED) ||
      (isBonus && process.env.AUTOSEND_TEMPLATE_TRANSACTION_BONUS) ||
      universalTemplateId;

    await strapi.service('api::global.autosend-service').send({
      to: userEmail,
      templateId,
      dynamicData,
      tags: tags || ['transaction', statusLabel],
    });

    try {
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          email_sent_at: new Date(),
          metadata: { ...meta, emails_sent: [...emailsSent, statusLabel] },
        },
      });
    } catch (stampErr) {
      console.error(`[EMAIL] Failed to stamp email_sent_at for tx ${transaction.id}:`, stampErr.message);
    }

    console.log(`[EMAIL] Transaction ${statusLabel} email sent for tx ${transaction.id} to ${userEmail}`);
    return { sent: true };
  },

  /**
   * Send transaction approval email (for withdrawal requests)
   */
  async sendTransactionApprovalEmail(transaction, userEmail) {
    return this.sendTransactionEmail({
      transaction,
      userEmail,
      statusLabel: 'approved',
      statusMessage: 'Your withdrawal request has been approved and will be processed soon.',
      // Intentionally do NOT use transaction.description — it includes the
      // internal platform-fee breakdown ("$X payout + $Y platform fee") which
      // shouldn't be surfaced to the user. Leaving notes blank lets the
      // template's {{#if notes}} guard hide the Details section entirely.
      notes: transaction.notes || '',
      flags: { is_withdrawal: true },
      extra: { withdrawal_timeline: this.getWithdrawalTimeline(transaction.gateway) },
      tags: ['transaction', 'withdrawal', 'approved'],
    });
  },

  /**
   * Send transaction denial email (for rejected withdrawal requests)
   */
  async sendTransactionDenialEmail(transaction, userEmail, denialReason) {
    return this.sendTransactionEmail({
      transaction,
      userEmail,
      statusLabel: 'denied',
      statusMessage: "We're sorry, but your withdrawal request has been denied. Please review the reason below and contact support if you need assistance.",
      notes: denialReason || transaction.notes || 'Your request did not meet our withdrawal criteria.',
      flags: { is_withdrawal: true },
      extra: { withdrawal_timeline: 'Request denied' },
      tags: ['transaction', 'withdrawal', 'denied'],
    });
  },

  /**
   * Send payment confirmation email (for deposits and earnings)
   */
  async sendPaymentConfirmationEmail(transaction, userEmail) {
    const isEarning = !!transaction.order;
    const clientUrl = process.env.CLIENT_URL || '';
    return this.sendTransactionEmail({
      transaction,
      userEmail,
      statusLabel: 'success',
      statusMessage: isEarning
        ? "Congratulations! You've received payment for completing an order."
        : 'Your payment has been successfully processed and credited to your wallet.',
      flags: isEarning ? { is_earning: true } : { is_wallet_credit: true },
      extra: isEarning
        ? {
            order_id: transaction.order?.id,
            publisher_website: transaction.order?.website?.name || transaction.order?.website?.url,
            view_order_url: transaction.order ? `${clientUrl}/orders/order-detail/${transaction.order.id}` : undefined,
          }
        : {},
      tags: isEarning
        ? ['transaction', 'earning', 'payment', 'success']
        : ['transaction', 'deposit', 'payment', 'success'],
    });
  },

  /**
   * Send withdrawal request email (when user creates a withdrawal request)
   */
  async sendWithdrawalRequestEmail(transaction, userEmail, withdrawalRequest) {
    return this.sendTransactionEmail({
      transaction: { ...transaction, gateway: transaction.gateway || withdrawalRequest.method },
      userEmail,
      statusLabel: 'pending',
      statusMessage: "We've received your withdrawal request. Our team will review it and process it within 1-3 business days.",
      notes: transaction.notes || 'Your withdrawal request has been received and is pending admin approval.',
      flags: { is_withdrawal: true },
      extra: { withdrawal_timeline: this.getWithdrawalTimeline(withdrawalRequest.method) },
      tags: ['transaction', 'withdrawal', 'request', 'pending'],
    });
  },

  /**
   * Send withdrawal paid email (when admin marks withdrawal as paid)
   */
  async sendWithdrawalPaidEmail(transaction, userEmail, withdrawalRequest) {
    return this.sendTransactionEmail({
      transaction: {
        ...transaction,
        amount: transaction.amount || withdrawalRequest.amount,
        gateway: transaction.gateway || withdrawalRequest.method,
      },
      userEmail,
      statusLabel: 'paid',
      statusMessage: 'Great news! Your withdrawal request has been completed. The funds should appear in your account within 1-3 business days.',
      notes: transaction.payment_notes || transaction.notes || `Your withdrawal has been completed and the funds have been transferred to your ${withdrawalRequest.method} account.`,
      flags: { is_withdrawal: true },
      extra: { withdrawal_timeline: 'Payment completed' },
      tags: ['transaction', 'withdrawal', 'paid', 'completed'],
    });
  },

  /**
   * Helper: Get estimated withdrawal timeline based on payment gateway
   */
  getWithdrawalTimeline(gateway) {
    const timelines = {
      'paypal': '1-2 business days',
      'stripe': '2-5 business days',
      'bank_transfer': '3-7 business days',
      'system': '1-3 business days'
    };

    return timelines[gateway?.toLowerCase()] || '2-5 business days';
  },

  /**
   * Send withdrawal OTP verification email via AutoSend template.
   * Template variables: first_name, otp, year.
   */
  async sendWithdrawalOtpEmail(otpCode, userEmail, amount, recipient = {}) {
    try {
      const firstName =
        recipient.firstName ||
        recipient.username ||
        (userEmail ? userEmail.split('@')[0] : 'there');

      const validityMinutes = recipient.validityMinutes || 10;
      const validityText = `${validityMinutes} ${validityMinutes === 1 ? 'Minute' : 'Minutes'}`;
      const emailData = {
        to: userEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_WITHDRAWAL_OTP || 'A-a3dc625caab7c580efef',
        dynamicData: {
          first_name: firstName,
          otp: otpCode,
          amount: amount,
          validity_minutes: validityMinutes,
          validity_text: validityText,
          year: new Date().getFullYear(),
        },
        tags: ['withdrawal', 'otp', 'verification'],
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[WithdrawalOTP] AutoSend email sent to ${userEmail} (messageId: ${result?.messageId})`);
      return result;
    } catch (error) {
      console.error('Error sending withdrawal OTP email:', error);
      throw error;
    }
  },

  /**
   * Parse incoming email for commands
   */
  async parseEmailCommand(emailBody, senderEmail) {
    try {
      const commands = [
        'CONFIRM-PAYMENT',
        'ACCEPT',
        'REJECT',
        'APPROVE',
        'DISPUTE',
        'DELIVER',
        'COMPLETE'
      ];

      const emailContent = emailBody.toUpperCase();
      let matchedCommand = null;
      let entityId = null;

      for (const command of commands) {
        const regex = new RegExp(`${command}-(\\d+)`, 'i');
        const match = emailContent.match(regex);
        if (match) {
          matchedCommand = command;
          entityId = parseInt(match[1]);
          break;
        }
      }

      if (matchedCommand && entityId) {
        return await this.executeEmailCommand(matchedCommand, entityId, senderEmail);
      }

      return { success: false, message: 'No valid command found in email' };
    } catch (error) {
      console.error('Error parsing email command:', error);
      return { success: false, message: 'Error processing email command' };
    }
  },

  /**
   * Execute email command
   */
  async executeEmailCommand(command, entityId, senderEmail) {
    try {
      // Find user by email
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: senderEmail }
      });

      if (!user) {
        return { success: false, message: 'User not found' };
      }

      const ctx = { state: { user } };

      switch (command) {
        case 'CONFIRM-PAYMENT':
          return await this.handlePaymentConfirmation(entityId, user);

        case 'ACCEPT':
          return await this.handleOrderAcceptance(entityId, user);

        case 'REJECT':
          return await this.handleOrderRejection(entityId, user);

        case 'APPROVE':
          return await this.handleOrderApproval(entityId, user);

        case 'DISPUTE':
          return await this.handleOrderDispute(entityId, user);

        case 'DELIVER':
          return await this.handleOrderDelivery(entityId, user);

        case 'COMPLETE':
          return await this.handleOrderCompletion(entityId, user);

        default:
          return { success: false, message: 'Unknown command' };
      }
    } catch (error) {
      console.error('Error executing email command:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle payment confirmation via email
   */
  async handlePaymentConfirmation(orderId, user) {
    try {
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id: orderId },
        populate: ['advertiser']
      });

      if (!order) {
        return { success: false, message: 'Order not found' };
      }

      if (order.advertiser.id !== user.id) {
        return { success: false, message: 'Not authorized to confirm payment for this order' };
      }

      // Process payment confirmation logic here
      // This would typically involve updating the order status and processing payment

      await strapi.entityService.update('api::order.order', orderId, {
        data: {
          paymentConfirmed: true,
          paymentConfirmedAt: new Date()
        }
      });

      return { success: true, message: `Payment confirmed for order #${orderId}` };
    } catch (error) {
      console.error('Error handling payment confirmation:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order acceptance via email
   */
  async handleOrderAcceptance(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.acceptOrder(ctx);

      if (result.data) {
        return { success: true, message: `Order #${orderId} accepted successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order acceptance:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order rejection via email
   */
  async handleOrderRejection(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        request: { body: { reason: 'Rejected via email' } },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.rejectOrder(ctx);

      if (result.data) {
        return { success: true, message: `Order #${orderId} rejected successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order rejection:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order approval via email
   */
  async handleOrderApproval(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.completeOrder(ctx);

      if (result.data) {
        return { success: true, message: `Order #${orderId} approved and completed successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order approval:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order dispute via email
   */
  async handleOrderDispute(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        request: { body: { reason: 'Disputed via email' } },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.disputeOrder(ctx);

      if (result.data) {
        return { success: true, message: `Order #${orderId} disputed successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order dispute:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order delivery via email
   */
  async handleOrderDelivery(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        request: { body: { proof: 'Delivered via email confirmation' } },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.deliverOrder(ctx);

      if (result.data) {
        return { success: true, message: `Order #${orderId} marked as delivered successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order delivery:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order completion via email
   */
  async handleOrderCompletion(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.completeOrder(ctx);

      if (result.data) {
        return { success: true, message: `Order #${orderId} completed successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order completion:', error);
      return { success: false, message: error.message };
    }
  },

  // Email Templates

  /**
   * Generate payment acceptance email template
   */
  generatePaymentAcceptanceTemplate(orderId, amount) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .button { display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .alert { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Payment Required</h1>
          </div>
          <div class="content">
            <h2>Order #${orderId}</h2>
            <p>Hello,</p>
            <p>Your order #${orderId} has been created and requires payment of <strong>$${amount}</strong>.</p>
            
            <div class="alert">
              <strong>To confirm payment via email:</strong><br>
              Reply to this email with: <code>CONFIRM-PAYMENT-${orderId}</code>
            </div>
            
            <p>Alternatively, you can log into your dashboard to complete the payment.</p>
            
            <p>Thank you for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Send new message notification email
   * Triggered when an advertiser or publisher sends a message
   * @param {Object} params
   * @param {string} params.receiverEmail - Email of the message recipient
   * @param {string} params.receiverName - Name of the recipient
   * @param {string} params.senderRole - 'Advertiser' or 'Publisher'
   * @param {string} params.messageText - The message content
   * @param {Date} params.messageTime - When the message was sent
   * @param {Object} params.order - Order object with id, orderStatus, createdAt
   * @param {string} params.replyUrl - URL to reply to the message
   */
  async sendNewMessageEmail({ receiverEmail, receiverName, senderRole, messageText, messageTime, order, replyUrl }) {
    try {
      // Only send if messageText is present
      if (!messageText || !messageText.trim()) {
        console.log('[Email] Skipping new message email - no message text provided');
        return null;
      }

      console.log(`[Email] Sending new message notification to ${receiverEmail}`);

      const emailData = {
        to: receiverEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_MESSAGE || 'A-073201ea7356ec9df066',
        dynamicData: {
          sender_role: senderRole,
          receiver_name: receiverName || 'User',
          message_text: messageText,
          message_time: messageTime ? new Date(messageTime).toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          }) : '',
          order_id: order?.id ? String(order.id) : '',
          order_status: formatOrderStatus(order?.orderStatus) || 'Active',
          order_date: order?.createdAt ? new Date(order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          }) : '',
          reply_url: replyUrl || `${process.env.CLIENT_URL}/orders/order-detail/${order?.id}`,
          logo_url: `${process.env.CLIENT_URL}/logo.png`,
          year: new Date().getFullYear().toString()
        },
        tags: ['communication', 'new-message', 'order-message']
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[Email] New message notification sent to ${receiverEmail}`);
      return result;
    } catch (error) {
      console.error('[Email] Error sending new message notification:', error);
      // Non-blocking - don't throw
      return null;
    }
  },

  /**
   * Send delivery overdue warning email to publisher via AutoSend
   * Called by the order-cancellation cron job when an accepted order
   * has not been delivered within 30 days.
   */
  async sendDeliveryOverdueWarningEmail(order, publisherEmail) {
    try {
      console.log(`[EMAIL] Sending delivery overdue warning for order #${order.id} to ${publisherEmail}`);

      const emailData = {
        to: publisherEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_DELIVERY_OVERDUE || 'A-53833cb8ddab6120cd94',
        dynamicData: {
          // Order details
          order_id: order.id,
          order_status: formatOrderStatus('delivery_overdue'),
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',

          // User details
          publisher_name: order.publisher?.username || order.publisher?.email || 'Publisher',
          advertiser_name: order.advertiser?.username || order.advertiser?.email || 'Advertiser',

          // Website details
          website_name: order.website?.name || order.website?.url || 'Website',
          website_url: order.website?.url || '',

          // Warning-specific details
          days_since_accepted: 30,
          days_remaining: 15,
          total_deadline_days: 45,

          // Action URLs
          order_link: `${process.env.CLIENT_URL}/publisher/order-detail/${order.id}`,
          dashboard_url: `${process.env.CLIENT_URL}/publisher/my-orders`,

          // Timestamp
          accepted_date: order.acceptedDate
            ? new Date(order.acceptedDate).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })
            : 'N/A',
          warning_date: new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),

          // Branding
          logo_url: `${process.env.CLIENT_URL}/logo.png`,
          year: new Date().getFullYear().toString()
        },
        tags: ['order', 'delivery-overdue', 'warning', 'publisher']
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[EMAIL] Delivery overdue warning sent for order #${order.id} to ${publisherEmail}`);
      return result;
    } catch (error) {
      console.error('[EMAIL] Error sending delivery overdue warning:', error);
      throw error;
    }
  },

  /**
   * Send project created confirmation email to the user
   * @param {Object} project - The created project entity
   * @param {Object} user - The user who created the project
   */
  async sendProjectCreatedEmail(project, user) {
    try {
      const emailData = {
        to: user.email,
        templateId: process.env.AUTOSEND_TEMPLATE_PROJECT_CREATED || 'A-a3dc625caab7c580efef',
        dynamicData: {
          user_name: user.username || user.email,
          project_name: project.ProjectName,
          project_type: project.status || 'active',
          created_date: new Date(project.createdAt || Date.now()).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })
        },
        tags: ['project', 'project-created']
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[EMAIL] Project created email sent for project "${project.ProjectName}" to ${user.email}`);
      return result;
    } catch (error) {
      console.error('[EMAIL] Error sending project created email:', error);
      throw error;
    }
  },

  /**
   * Send order confirmation email to advertiser after order is placed
   * Uses the universal order template with is_order_confirmation flag
   * @param {Object} order - The populated order entity
   * @param {string} advertiserEmail - The advertiser's email address
   */
  async sendOrderConfirmationAdvertiserEmail(order, advertiserEmail) {
    try {
      const emailData = {
        to: advertiserEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_ORDER_UNIVERSAL || 'A-6b3a9831dc557c0df9ab',
        dynamicData: {
          is_order_confirmation: true,
          advertiser_name: order.advertiser?.username || order.advertiser?.email || 'Advertiser',
          order_id: order.id,
          order_status: formatOrderStatus('Pending'),
          order_date: new Date(order.orderDate || order.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          website_url: order.website?.url || '',
          website_name: order.website?.name || order.website?.url || '',
          total_amount: order.totalAmount || 0,
          currency: 'USD',
          order_description: order.description || '',
          order_link: `${process.env.CLIENT_URL}/orders`,
          dashboard_url: `${process.env.CLIENT_URL}/orders`,
          logo_url: `${process.env.CLIENT_URL}/logo.png`,
          year: new Date().getFullYear().toString()
        },
        tags: ['order', 'order-confirmation', 'advertiser']
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[EMAIL] Order confirmation email sent for order #${order.id} to ${advertiserEmail}`);
      return result;
    } catch (error) {
      console.error('[EMAIL] Error sending order confirmation email to advertiser:', error);
      throw error;
    }
  },

  /**
   * Send password reset email with reset link
   * @param {Object} user - The user requesting password reset
   * @param {string} resetUrl - The full password reset URL with token
   */
  async sendPasswordResetEmail(user, resetUrl) {
    try {
      const emailData = {
        to: user.email,
        templateId: process.env.AUTOSEND_TEMPLATE_PASSWORD_RESET || 'A-87b1c4ac38bf257e7894',
        dynamicData: {
          user_name: user.username || user.email,
          is_password_updated: false,
          reset_password_url: resetUrl,
          year: new Date().getFullYear().toString()
        },
        tags: ['auth', 'password-reset']
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[EMAIL] Password reset email sent to ${user.email}`);
      return result;
    } catch (error) {
      console.error('[EMAIL] Error sending password reset email:', error);
      throw error;
    }
  },

  /**
   * Send password changed confirmation email
   * @param {Object} user - The user whose password was changed
   */
  async sendPasswordChangedEmail(user) {
    try {
      const emailData = {
        to: user.email,
        templateId: process.env.AUTOSEND_TEMPLATE_PASSWORD_RESET || 'A-87b1c4ac38bf257e7894',
        dynamicData: {
          user_name: user.username || user.email,
          is_password_updated: true,
          year: new Date().getFullYear().toString()
        },
        tags: ['auth', 'password-changed']
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[EMAIL] Password changed confirmation email sent to ${user.email}`);
      return result;
    } catch (error) {
      console.error('[EMAIL] Error sending password changed email:', error);
      throw error;
    }
  },

  /**
   * Send publisher website status update email
   * @param {Object} params
   * @param {string} params.publisherEmail - Publisher's email address
   * @param {string} params.publisherName - Publisher's name for greeting
   * @param {string} params.websiteName - Website name/domain
   * @param {string} params.websiteUrl - Website URL
   * @param {string} params.actionType - Status label (e.g. "Approved and Live", "Rejected", "Removed")
   * @param {string} [params.notes] - Optional notes (rejection reason, admin notes, etc.)
   * @param {boolean} [params.is_added] - Set to true for "website added" variant
   */
  async sendWebsiteStatusEmail({ publisherEmail, publisherName, websiteName, websiteUrl, actionType, notes, is_added }) {
    try {
      const emailData = {
        to: publisherEmail,
        templateId: process.env.AUTOSEND_TEMPLATE_WEBSITE_STATUS || 'A-1795cd1dfeb6e7d49155',
        dynamicData: {
          publisher_name: publisherName || publisherEmail,
          website_name: websiteName || websiteUrl || '',
          website_url: websiteUrl || '',
          action_type: actionType,
          notes: notes || '',
          is_added: is_added || false,
          year: new Date().getFullYear().toString()
        },
        tags: ['website', 'status-update', actionType.toLowerCase().replace(/\s+/g, '-')]
      };

      const result = await strapi.service('api::global.autosend-service').send(emailData);
      console.log(`[EMAIL] Website status email sent: "${actionType}" for ${websiteName} to ${publisherEmail}`);
      return result;
    } catch (error) {
      console.error('[EMAIL] Error sending website status email:', error);
      throw error;
    }
  },

  // ============================================
  // WEBSITE TRANSFER EMAIL FUNCTIONS
  // ============================================

  /**
   * Notify the previous owner that an admin has transferred their website
   * to another user. Sent via AutoSend (autosendjs SDK directly) so it
   * goes out through the same provider as other transactional emails.
   * Uses AUTOSEND_TEMPLATE_WEBSITE_TRANSFER_OUT if set, otherwise inline HTML.
   */
  async sendWebsiteTransferOutEmail({ website, previousOwner, newOwner, reason }) {
    try {
      if (!previousOwner?.email) return;

      const apiKey = process.env.AUTOSEND_API_KEY;
      if (!apiKey) {
        console.warn(
          '[EMAIL] AUTOSEND_API_KEY not set — skipping website transfer-out email.'
        );
        return;
      }

      const recipientName = previousOwner.username || previousOwner.email;
      const newOwnerName = newOwner?.username || newOwner?.email || 'a new owner';
      const websiteName = website?.url || 'your website';

      const { Autosend } = require('autosendjs');
      const autosend = new Autosend(apiKey);

      const fromEmail =
        process.env.EMAIL_FROM ||
        process.env.AUTOSEND_FROM_EMAIL ||
        'noreply@serpbays.com';

      const basePayload = {
        from: { email: fromEmail },
        to: { email: previousOwner.email },
        tags: ['serpbays', 'website-transfer', 'transferred-out']
      };

      const templateId = process.env.AUTOSEND_TEMPLATE_WEBSITE_TRANSFER_OUT;
      let payload;
      if (templateId) {
        payload = {
          ...basePayload,
          templateId,
          dynamicData: {
            recipient_name: recipientName,
            new_owner_name: newOwnerName,
            new_owner_email: newOwner?.email || '',
            website_name: websiteName,
            reason: reason || ''
          }
        };
      } else {
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#111827;margin:0 0 12px;">Hi ${recipientName},</h2>
            <p>An admin has transferred ownership of <strong>${websiteName}</strong> to <strong>${newOwnerName}</strong>.</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            <p>Any orders that were already in progress remain assigned to you, and you are still responsible for completing and being paid for them. New orders on this website will route to the new owner.</p>
            <p style="color:#6b7280;font-size:13px;">If you didn't expect this, please contact support@serpbays.com immediately.</p>
          </div>
        `;
        payload = {
          ...basePayload,
          subject: `Website ownership transferred — ${websiteName}`,
          html,
          text: `${websiteName} ownership has been transferred to ${newOwnerName}. Existing orders remain with you.`
        };
      }

      const result = await autosend.emails.send(payload);
      if (!result?.success) {
        throw new Error(result?.error || 'AutoSend returned an error');
      }

      console.log(
        `[EMAIL] Website transfer-out notice sent via AutoSend to ${previousOwner.email} (id: ${result.data?.emailId})`
      );
    } catch (error) {
      console.error('[EMAIL] sendWebsiteTransferOutEmail failed:', error);
      // Non-fatal — caller already handles
    }
  }
}));
