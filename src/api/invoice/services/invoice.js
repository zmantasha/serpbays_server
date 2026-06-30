'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

/**
 * Single source of truth for wallet-deposit invoice creation.
 *
 * Called from each gateway webhook (Stripe / PayPal / Razorpay) after a
 * deposit transaction is marked success and the wallet is credited.
 *
 * Idempotent — re-calling for the same transaction returns the existing
 * invoice instead of creating a duplicate. Keyed off transactionId (the
 * stringified Strapi transaction.id), because the invoice schema stores
 * that as a string, not a FK.
 *
 * Scope: ONLY runs for type === 'deposit' && transactionStatus === 'success'.
 * Order-payment / escrow-release / withdrawal flows are unaffected.
 */

const generateInvoiceNumber = async (strapi) => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const prefix = `INV-${year}-${month}-`;
  const count = await strapi.db.query('api::invoice.invoice').count({
    where: { invoiceNumber: { $startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
};

// Map the user-model fields (billingAddress, city, country, pincode,
// vatGstNumber, firstName/lastName/businessName/username) onto the
// invoice schema's billing* columns. The user schema does NOT have
// billing-prefixed city/country/pincode fields — those are plain
// city / country / pincode. Pre-refactor code read the wrong field
// names, so invoices rendered with empty city/country values.
const buildBillingFromUser = (user) => {
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  const billingName =
    fullName ||
    user?.businessName ||
    user?.username ||
    'Customer';
  return {
    billingName,
    billingAddress: user?.billingAddress || 'N/A',
    billingCity: user?.city || '',
    billingCountry: user?.country || '',
    billingPincode: user?.pincode || '',
    billingVatGst: user?.vatGstNumber || '',
  };
};

const resolveCurrency = (transaction) => {
  const raw =
    transaction?.currency ||
    transaction?.metadata?.currency ||
    'USD';
  return String(raw).toUpperCase();
};

module.exports = createCoreService('api::invoice.invoice', ({ strapi }) => ({
  /**
   * Create an invoice for a successful wallet-deposit transaction.
   *
   * Returns the invoice (newly created or pre-existing if idempotent).
   * Returns null when the transaction isn't eligible (wrong type/status) —
   * callers can fire-and-forget without worrying about silent failures
   * blowing up the webhook.
   */
  async createInvoiceForTransaction(transaction, user) {
    if (!transaction || !transaction.id) {
      throw new Error('createInvoiceForTransaction: transaction with id is required');
    }
    if (!user || !user.id) {
      throw new Error('createInvoiceForTransaction: user with id is required');
    }
    if (transaction.type !== 'deposit') {
      strapi.log.warn(
        `[invoice.service] tx ${transaction.id} type=${transaction.type} not 'deposit' — skip`
      );
      return null;
    }
    if (transaction.transactionStatus !== 'success') {
      strapi.log.warn(
        `[invoice.service] tx ${transaction.id} status=${transaction.transactionStatus} not 'success' — skip`
      );
      return null;
    }

    // Idempotency — invoice already exists for this transactionId? Return it.
    // Two paths can hit us: (a) gateway webhook retry; (b) parallel-pod race
    // on the same event. Either way, dedupe by stringified transactionId.
    const txIdStr = String(transaction.id);
    const existing = await strapi.db.query('api::invoice.invoice').findOne({
      where: { transactionId: txIdStr },
    });
    if (existing) {
      strapi.log.info(
        `[invoice.service] tx ${transaction.id} already has invoice ${existing.invoiceNumber} — skip`
      );
      return existing;
    }

    const billing = buildBillingFromUser(user);
    const invoiceNumber = await generateInvoiceNumber(strapi);

    const amount = Number(transaction.amount) || 0;
    const currency = resolveCurrency(transaction);

    const lineItems = [{
      description: 'Wallet Deposit',
      quantity: 1,
      unitPrice: amount,
      amount,
    }];

    const created = await strapi.entityService.create('api::invoice.invoice', {
      data: {
        invoiceNumber,
        invoiceDate: new Date().toISOString().slice(0, 10),
        user: user.id,
        transactionId: txIdStr,
        ...billing,
        lineItems,
        subtotal: amount,
        taxAmount: 0,
        totalAmount: amount,
        currency,
        status: 'paid',
        pdfUrl: null,
        notes: `Wallet deposit via ${transaction.gateway || 'gateway'} — tx ${transaction.id}`,
      },
    });

    // Link invoice back to the transaction so the wallet-tx list surfaces
    // the "Download Invoice" button. Best-effort — if the link fails the
    // invoice still exists and a retry (idempotent) will reuse it.
    try {
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: { invoice: created.id },
      });
    } catch (linkErr) {
      strapi.log.warn(
        `[invoice.service] link invoice ${created.id} → tx ${transaction.id} failed: ${linkErr.message}`
      );
    }

    strapi.log.info(
      `[invoice.service] invoice ${created.invoiceNumber} created for tx ${transaction.id} (${currency} ${amount})`
    );
    return created;
  },
}));
