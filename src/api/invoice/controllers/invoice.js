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

      // Create PDF document with better page settings
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50
      });

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
          // Define colors
          const primaryColor = '#1a237e';
          const secondaryColor = '#534bae';
          const textColor = '#424242';

          // Helper function to format currency
          const formatCurrency = (amount) => `$${Number(amount).toFixed(2)}`;

          // Add company logo space (top-left)
          doc.rect(50, 50, 150, 50).stroke();
          doc.fontSize(10).text('Company Logo', 75, 65);

          // Add company info (top-right)
          doc.fontSize(20)
            .fillColor(primaryColor)
            .text('Serpbays', 350, 50, { align: 'right' })
            .fontSize(12)
            .fillColor(secondaryColor)
            .text('Your Digital Marketing Partner', 350, 75, { align: 'right' })
            .moveDown();

          // Add divider line
          doc.moveTo(50, 120)
             .lineTo(550, 120)
             .strokeColor(primaryColor)
             .stroke();

          // Invoice title and details
          doc.moveDown()
             .fontSize(24)
             .fillColor(primaryColor)
             .text('INVOICE', 50, 140)
             .fontSize(10)
             .fillColor(textColor)
             .text(`Invoice Number: ${invoice.invoiceNumber}`, 50, 170)
             .text(`Date: ${new Date(invoice.invoiceDate).toLocaleDateString()}`, 50, 185);

          // Billing Information
          doc.fontSize(14)
             .fillColor(primaryColor)
             .text('Bill To:', 50, 220)
             .fontSize(10)
             .fillColor(textColor);

          // Client details with proper spacing
          const clientDetails = [
            invoice.billingName,
            invoice.billingAddress,
            `${invoice.billingCity || ''}, ${invoice.billingCountry || ''}`,
            invoice.billingPincode ? `Pincode: ${invoice.billingPincode}` : '',
            invoice.billingVatGst ? `VAT/GST: ${invoice.billingVatGst}` : ''
          ].filter(Boolean);

          clientDetails.forEach((detail, index) => {
            doc.text(detail, 50, 245 + (index * 15));
          });

          // Line Items Table
          doc.moveDown(4);
          const tableTop = 350;
          const tableHeaders = ['Description', 'Amount'];
          
          // Draw table header
          doc.fontSize(10)
             .fillColor(primaryColor);
          
          // Table header background
          doc.rect(50, tableTop - 20, 500, 20)
             .fillColor(primaryColor)
             .fill();
          
          // Table header text
          doc.fillColor('#FFFFFF')
             .text('Description', 60, tableTop - 15)
             .text('Amount', 450, tableTop - 15);

          // Add line items
          let currentY = tableTop + 10;
          if (Array.isArray(invoice.lineItems)) {
            invoice.lineItems.forEach((item, index) => {
              const isEven = index % 2 === 0;
              
              // Light background for alternate rows
              if (isEven) {
                doc.rect(50, currentY - 15, 500, 20)
                   .fillColor('#f5f5f5')
                   .fill();
              }

              doc.fillColor(textColor)
                 .text(item.description || '', 60, currentY - 10)
                 .text(formatCurrency(item.amount || 0), 450, currentY - 10);
              
              currentY += 25;
            });
          }

          // Summary section
          currentY += 20;
          const summaryX = 350;
          const summaryStartY = currentY;

          // Summary box
          doc.rect(summaryX, summaryStartY, 200, 100)
             .fillColor('#f8f9fa')
             .fill()
             .strokeColor(primaryColor)
             .stroke();

          // Summary details
          doc.fillColor(textColor)
             .fontSize(10)
             .text('Subtotal:', summaryX + 20, summaryStartY + 20)
             .text(formatCurrency(invoice.subtotal || 0), summaryX + 120, summaryStartY + 20)
             .text('Tax:', summaryX + 20, summaryStartY + 40)
             .text(formatCurrency(invoice.taxAmount || 0), summaryX + 120, summaryStartY + 40);

          // Total with highlighted background
          doc.rect(summaryX, summaryStartY + 60, 200, 30)
             .fillColor(primaryColor)
             .fill()
             .fillColor('#FFFFFF')
             .fontSize(12)
             .text('Total:', summaryX + 20, summaryStartY + 68)
             .text(formatCurrency(invoice.totalAmount || 0), summaryX + 120, summaryStartY + 68);

          // Footer
          const footerY = doc.page.height - 100;
          doc.moveTo(50, footerY)
             .lineTo(550, footerY)
             .strokeColor(primaryColor)
             .stroke();

          doc.fontSize(10)
             .fillColor(textColor)
             .text('Thank you for your business!', 50, footerY + 15, { align: 'center' })
             .fontSize(8)
             .text('For any questions about this invoice, please contact support@serpbays.com', 50, footerY + 35, { align: 'center' });

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
