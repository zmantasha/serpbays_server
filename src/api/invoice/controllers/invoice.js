'use strict';

/**
 * invoice controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const PDFDocument = require('pdfkit');

module.exports = createCoreController('api::invoice.invoice', ({ strapi }) => ({
  /**
   * Download an invoice PDF.
   * Route: GET /api/invoices/:id/download
   */
  async download(ctx) {
    try {
      const { id } = ctx.params;
      const userId = ctx.state.user?.id;

      console.log('Download request received for invoice:', id);
      console.log('User ID:', userId);
      console.log('Request headers:', ctx.request.headers);
      console.log('Auth header:', ctx.request.header.authorization);

      if (!userId) {
        console.log('No user ID found in request');
        return ctx.unauthorized('You must be logged in to download invoices.');
      }

      // Find the invoice with related user
      console.log('Finding invoice with ID:', id);
      const invoice = await strapi.entityService.findOne('api::invoice.invoice', id, {
        populate: ['user']
      });

      console.log('Found invoice:', invoice);
      
      if (!invoice) {
        console.log('Invoice not found:', id);
        return ctx.notFound('Invoice not found');
      }

      console.log('Invoice user ID:', invoice.user?.id);
      console.log('Request user ID:', userId);

      // Check if the user owns this invoice
      if (invoice.user?.id !== userId) {
        console.log('User does not own this invoice');
        return ctx.forbidden('You do not have permission to download this invoice');
      }

      // Create PDF document
      const doc = new PDFDocument();
      
      // Set response status to 200 and headers
      ctx.status = 200;
      ctx.response.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`,
        'Transfer-Encoding': 'chunked'
      });
      
      // Create a promise to handle the PDF generation
      return new Promise((resolve, reject) => {
        // Handle any errors that occur during PDF generation
        doc.on('error', (err) => {
          console.error('Error generating PDF:', err);
          reject(err);
        });

        // Pipe the PDF to the response
        doc.pipe(ctx.response.res);

        try {
          // Add content to PDF
          doc
            .fontSize(20)
            .text('INVOICE', { align: 'center' })
            .moveDown()
            .fontSize(12);

          // Add company info
          doc
            .text('Serpbays', { align: 'right' })
            .text('Your Digital Marketing Partner', { align: 'right' })
            .moveDown();

          // Add invoice details
          doc
            .text(`Invoice Number: ${invoice.invoiceNumber}`)
            .text(`Date: ${new Date(invoice.invoiceDate).toLocaleDateString()}`)
            .moveDown()
            .text('Bill To:')
            .text(invoice.billingName || '')
            .text(invoice.billingAddress || '');

          if (invoice.billingCity || invoice.billingCountry) {
            doc.text(`${invoice.billingCity || ''}, ${invoice.billingCountry || ''}`);
          }
          
          if (invoice.billingPincode) {
            doc.text(`Pincode: ${invoice.billingPincode}`);
          }
          
          if (invoice.billingVatGst) {
            doc.text(`VAT/GST: ${invoice.billingVatGst}`);
          }
          
          doc.moveDown();

          // Add line items table header
          const startX = 50;
          let currentY = doc.y;
          
          doc
            .text('Description', startX, currentY)
            .text('Amount', 400, currentY)
            .moveDown();

          // Add line items
          if (Array.isArray(invoice.lineItems)) {
            invoice.lineItems.forEach(item => {
              currentY = doc.y;
              doc
                .text(item.description || '', startX, currentY)
                .text(`$${(item.amount || 0).toFixed(2)}`, 400, currentY)
                .moveDown();
            });
          }

          // Add totals
          doc.moveDown();
          const totalsX = 400;
          currentY = doc.y;
          
          doc
            .text('Subtotal:', 300, currentY)
            .text(`$${(invoice.subtotal || 0).toFixed(2)}`, totalsX, currentY)
            .moveDown();
          
          currentY = doc.y;
          doc
            .text('Tax:', 300, currentY)
            .text(`$${(invoice.taxAmount || 0).toFixed(2)}`, totalsX, currentY)
            .moveDown();
          
          currentY = doc.y;
          doc
            .text('Total:', 300, currentY)
            .text(`$${(invoice.totalAmount || 0).toFixed(2)}`, totalsX, currentY)
            .moveDown();

          // Add footer
          doc
            .moveDown(2)
            .fontSize(10)
            .text('Thank you for your business!', { align: 'center' })
            .moveDown()
            .text('For any questions about this invoice, please contact support@serpbays.com', { align: 'center' });

          console.log('Ending PDF document generation');
          // End the document
          doc.end();
          
          // Resolve when the document is finished
          doc.on('end', () => {
            console.log('PDF generation completed successfully');
            resolve();
          });
        } catch (pdfError) {
          console.error('Error during PDF generation:', pdfError);
          reject(pdfError);
        }
      }).catch(error => {
        console.error('Error in PDF generation promise:', error);
        return ctx.internalServerError('Error generating invoice PDF');
      });
    } catch (error) {
      console.error('Error in download controller:', error);
      return ctx.internalServerError('Error generating invoice PDF');
    }
  }
}));
