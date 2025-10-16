'use strict';

/**
 * Bank Transfer Request Controller
 * Handles bank transfer requests from users
 */

module.exports = {
  /**
   * Create a new bank transfer request
   */
  async create(ctx) {
    try {
      const { amount, referenceNumber, notes, transactionId, userId, userEmail, userName } = ctx.request.body;

      // Validate required fields
      if (!amount || !referenceNumber || !transactionId || !userId) {
        return ctx.badRequest('Amount, reference number, transaction ID, and user ID are required');
      }

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      // Create bank transfer request
      const bankTransferRequest = await strapi.entityService.create('api::bank-transfer-request.bank-transfer-request', {
        data: {
          amount: parsedAmount,
          referenceNumber,
          transactionId,
          notes: notes || '',
          userId: userId,
          userEmail,
          userName,
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      // Send notification email to admin
      try {
        await strapi.plugins['email'].services.email.send({
          to: process.env.ADMIN_EMAIL || 'admin@serpbays.com',
          subject: `New Bank Transfer Request - ${referenceNumber}`,
          html: `
            <h2>New Bank Transfer Request</h2>
            <p><strong>User:</strong> ${userName} (${userEmail})</p>
            <p><strong>Amount:</strong> $${parsedAmount.toFixed(2)}</p>
            <p><strong>Reference Number:</strong> ${referenceNumber}</p>
            <p><strong>Transaction ID:</strong> ${transactionId}</p>
            <p><strong>Notes:</strong> ${notes || 'None'}</p>
            <p><strong>Request ID:</strong> ${bankTransferRequest.id}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            <hr>
            <p><strong>Action Required:</strong></p>
            <ul>
              <li>Wait for user to email vinayak@wordscloud.in with transfer receipt</li>
              <li>Verify the bank transfer using the reference number</li>
              <li>Update the user's wallet balance manually</li>
              <li>Processing time: up to 8 working hours after confirmation</li>
            </ul>
          `
        });
      } catch (emailError) {
        console.error('Failed to send admin notification email:', emailError);
        // Don't fail the request if email fails
      }

      // Send confirmation email to user
      try {
        await strapi.plugins['email'].services.email.send({
          to: userEmail,
          subject: `Bank Transfer Request Received - ${referenceNumber}`,
          html: `
            <h2>Bank Transfer Request Received</h2>
            <p>Dear ${userName},</p>
            <p>We have received your bank transfer request for <strong>$${parsedAmount.toFixed(2)}</strong>.</p>
            <p><strong>Reference Number:</strong> ${referenceNumber}</p>
            <p><strong>Transaction ID:</strong> ${transactionId}</p>
            <p><strong>Notes:</strong> ${notes || 'None'}</p>
            <hr>
            <h3>Next Steps:</h3>
            <ol>
              <li>Transfer $${parsedAmount.toFixed(2)} to our bank account using the reference number: <strong>${referenceNumber}</strong></li>
              <li>After making the transfer, email <strong>vinayak@wordscloud.in</strong> with your transfer receipt</li>
              <li>Processing time: <strong>up to 8 working hours</strong> after confirmation</li>
              <li>For faster processing, ask our support team to prioritize your request</li>
              <li>Keep your bank transfer receipt for reference</li>
            </ol>
            <h3>Bank Details:</h3>
            <p><strong>Bank Name:</strong> Serpbays Bank</p>
            <p><strong>Account Holder:</strong> Serpbays Inc.</p>
            <p><strong>Account Number:</strong> 9876543210</p>
            <p><strong>Routing Number:</strong> 021000021</p>
            <p><strong>SWIFT Code:</strong> SBUSUS33</p>
            <p><strong>Bank Address:</strong> 123 Business St, New York, NY 10001</p>
            <hr>
            <p>If you have any questions, please contact our support team.</p>
            <p>Best regards,<br>Serpbays Team</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send user confirmation email:', emailError);
        // Don't fail the request if email fails
      }

      ctx.send({
        message: 'Bank transfer request created successfully',
        data: {
          id: bankTransferRequest.id,
          amount: parsedAmount,
          referenceNumber,
          status: 'pending'
        }
      });

    } catch (error) {
      console.error('[BANK TRANSFER REQUEST] Error creating request:', error);
      return ctx.internalServerError('Failed to create bank transfer request');
    }
  },

  /**
   * Get all bank transfer requests (admin only)
   */
  async find(ctx) {
    try {
      const { page = 1, pageSize = 20, status, userId } = ctx.query;

      // Build filters
      const filters = {};
      if (status) filters.status = status;
      if (userId) filters.userId = userId;

      const requests = await strapi.db.query('api::bank-transfer-request.bank-transfer-request').findMany({
        where: filters,
        orderBy: { createdAt: 'desc' },
        limit: parseInt(pageSize),
        offset: (parseInt(page) - 1) * parseInt(pageSize)
      });

      const total = await strapi.db.query('api::bank-transfer-request.bank-transfer-request').count({
        where: filters
      });

      const pageCount = Math.ceil(total / parseInt(pageSize));

      ctx.send({
        data: requests,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount,
            total
          }
        }
      });

    } catch (error) {
      console.error('[BANK TRANSFER REQUEST] Error fetching requests:', error);
      return ctx.internalServerError('Failed to fetch bank transfer requests');
    }
  },

  /**
   * Update bank transfer request status (admin only)
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const { status, notes } = ctx.request.body;

      if (!status) {
        return ctx.badRequest('Status is required');
      }

      const validStatuses = ['pending', 'processing', 'completed', 'rejected'];
      if (!validStatuses.includes(status)) {
        return ctx.badRequest('Invalid status');
      }

      const request = await strapi.db.query('api::bank-transfer-request.bank-transfer-request').findOne({
        where: { id }
      });

      if (!request) {
        return ctx.notFound('Bank transfer request not found');
      }

      // Update the request
      const updatedRequest = await strapi.entityService.update('api::bank-transfer-request.bank-transfer-request', id, {
        data: {
          status,
          adminNotes: notes || request.adminNotes,
          updatedAt: new Date()
        }
      });

      // If status is completed, update user's wallet balance
      if (status === 'completed') {
        try {
          const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { users_permissions_user: request.userId }
          });

          if (wallet) {
            const newBalance = parseFloat(wallet.mainBalance || 0) + parseFloat(request.amount);
            await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
              data: {
                mainBalance: newBalance,
                balance: newBalance + parseFloat(wallet.promoBalance || 0)
              }
            });

            // Create transaction record
            await strapi.entityService.create('api::transaction.transaction', {
              data: {
                user_wallet: wallet.id,
                type: 'bank_transfer',
                amount: parseFloat(request.amount),
                description: `Bank transfer - Reference: ${request.referenceNumber}`,
                status: 'completed',
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
          }
        } catch (walletError) {
          console.error('Failed to update wallet balance:', walletError);
          // Don't fail the request if wallet update fails
        }
      }

      // Send status update email to user
      try {
        const statusMessages = {
          processing: 'Your bank transfer is being processed',
          completed: 'Your bank transfer has been completed and your wallet has been updated',
          rejected: 'Your bank transfer request has been rejected'
        };

        await strapi.plugins['email'].services.email.send({
          to: request.userEmail,
          subject: `Bank Transfer Request Update - ${request.referenceNumber}`,
          html: `
            <h2>Bank Transfer Request Update</h2>
            <p>Dear ${request.userName},</p>
            <p>Your bank transfer request (Reference: <strong>${request.referenceNumber}</strong>) status has been updated.</p>
            <p><strong>New Status:</strong> ${status.toUpperCase()}</p>
            <p><strong>Amount:</strong> $${parseFloat(request.amount).toFixed(2)}</p>
            ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
            <hr>
            <p>${statusMessages[status] || 'Your request status has been updated.'}</p>
            <p>If you have any questions, please contact our support team.</p>
            <p>Best regards,<br>Serpbays Team</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send status update email:', emailError);
        // Don't fail the request if email fails
      }

      ctx.send({
        message: 'Bank transfer request updated successfully',
        data: updatedRequest
      });

    } catch (error) {
      console.error('[BANK TRANSFER REQUEST] Error updating request:', error);
      return ctx.internalServerError('Failed to update bank transfer request');
    }
  }
};
