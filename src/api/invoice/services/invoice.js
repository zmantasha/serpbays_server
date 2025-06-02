'use strict';

/**
 * invoice service
 */

const { createCoreService } = require('@strapi/strapi').factories;

// Helper function to generate a unique invoice number (customize as needed)
const generateInvoiceNumber = async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const count = await strapi.db.query('api::invoice.invoice').count({
    where: {
      invoiceNumber: {
        $startsWith: `INV-${year}-${month}-`,
      },
    },
  });
  const sequence = String(count + 1).padStart(4, '0');
  return `INV-${year}-${month}-${sequence}`;
};

module.exports = createCoreService('api::invoice.invoice', ({ strapi }) => ({
  /**
   * Creates an invoice for a given successful transaction.
   * @param {object} transaction - The successful transaction object.
   * @param {object} user - The user object associated with the transaction.
   */
  async createInvoiceForTransaction(transaction, user) {
    if (!transaction || transaction.transactionStatus !== 'success' || transaction.type !== 'deposit') {
      throw new Error('Invoice can only be created for successful deposit transactions.');
    }
    if (!user) {
      throw new Error('User is required to create an invoice.');
    }

    // --- 1. Fetch User Billing Details ---
    // These fields should exist on your Strapi User model or a related profile component.
    // Adjust the field names if they differ on your User model.
    const billingName = user.name || user.username; // Or user.billingProfile.name
    const billingAddress = user.billingAddress || 'N/A'; // Or user.billingProfile.address
    const billingCity = user.billingCity || '';
    const billingCountry = user.billingCountry || '';
    const billingPincode = user.billingPincode || '';
    const billingVatGst = user.vatGstNumber || ''; // From user profile

    if (billingAddress === 'N/A') {
        console.warn(`User ${user.id} does not have complete billing address for invoice generation for transaction ${transaction.id}`);
        // Depending on policy, you might throw an error or proceed with available data
        // For now, we proceed but ideally, this should be complete.
    }

    // --- 2. Generate Invoice Number ---
    const invoiceNumber = await generateInvoiceNumber();

    // --- 3. Prepare Line Items ---
    const lineItems = [
      {
        description: transaction.description || `Wallet Deposit - Transaction ID: ${transaction.gatewayTransactionId || transaction.id}`,
        quantity: 1,
        unitPrice: transaction.amount,
        total: transaction.amount,
      },
      // You can add more line items if needed, e.g., for fees if they are part of the invoiced amount.
    ];
    const subtotal = transaction.amount;
    const totalAmount = transaction.amount; // Assuming no taxes for wallet deposits for now

    // --- 4. Create Invoice Entry ---
    const invoiceData = {
      invoiceNumber,
      invoiceDate: new Date().toISOString().slice(0, 10), // Current date
      user: user.id,
      transactionId: String(transaction.id), // Link to the wallet transaction
      billingName,
      billingAddress,
      billingCity,
      billingCountry,
      billingPincode,
      billingVatGst,
      lineItems,
      subtotal,
      taxAmount: 0, // Assuming 0 tax for now
      totalAmount,
      currency: transaction.currency.toUpperCase(),
      status: 'paid', // Assuming deposits are immediately considered paid for invoice purposes
      pdfUrl: null, // Placeholder for PDF URL
      notes: `Invoice for wallet deposit transaction ${transaction.id}.`,
    };

    try {
      const newInvoice = await strapi.entityService.create('api::invoice.invoice', {
        data: invoiceData,
        populate: ['user'], // Populate user if needed later
      });

      // --- 5. (Placeholder) PDF Generation & Storage ---
      // TODO: Implement PDF generation here.
      // Example steps:
      // 1. Generate PDF using a library (e.g., pdfmake, puppeteer) with newInvoice data.
      // 2. Upload the PDF to Strapi's media library or external storage (e.g., S3).
      //    const pdfFileBuffer = await generatePdfBuffer(newInvoice); // Your PDF generation function
      //    const uploadedFiles = await strapi.plugins.upload.services.upload.upload({
      //      data: { /* required file info */ },
      //      files: { path: pdfFileBuffer, name: `${invoiceNumber}.pdf`, type: 'application/pdf' },
      //    });
      //    const pdfUrl = uploadedFiles[0].url;
      // 3. Update the invoice with the PDF URL:
      //    await strapi.entityService.update('api::invoice.invoice', newInvoice.id, { data: { pdfUrl } });
      //    newInvoice.pdfUrl = pdfUrl; // Update in-memory object as well

      console.log(`Successfully created invoice ${newInvoice.id} for transaction ${transaction.id}`);
      return newInvoice;

    } catch (error) {
      console.error(`Error creating invoice for transaction ${transaction.id}: `, error);
      // Rethrow or handle as per your error strategy
      throw error;
    }
  },
}));
