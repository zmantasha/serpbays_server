'use strict';

/**
 * Bank Transfer Request Controller
 * Handles bank transfer requests from users
 */

module.exports = {
  /**
   * Create a new bank transfer request.
   *
   * SECURITY (pre-fix → post-fix):
   *   The pre-fix handler took `userId`, `userEmail`, `userName` from the
   *   request body and stamped them directly onto the record. The update
   *   path then read `request.userId` and credited THAT wallet on completion
   *   (L210-216). A logged-in attacker could POST:
   *     {amount: 1000, userId: <victim_or_self>, referenceNumber: <known>, ...}
   *   to fabricate a bank-transfer claim under any user id. When an admin
   *   later approved (matching the reference number against a real bank
   *   inflow, or via social-engineering), the named userId's wallet was
   *   credited — i.e. anyone could redirect or fabricate bank credits to
   *   any account. This is a direct wallet-impersonation primitive.
   *
   *   Fix: the JWT is the source of truth. userId/userEmail/userName are
   *   derived from ctx.state.user. Anything in the body is ignored. Bounds:
   *   amount ≤ $1M (no-overflow defense), referenceNumber + transactionId
   *   length-capped.
   */
  async create(ctx) {
    try {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized();

      const { amount, referenceNumber, notes, transactionId } = ctx.request.body || {};

      // Validate required fields (caller-supplied user fields IGNORED).
      if (!amount || !referenceNumber || !transactionId) {
        return ctx.badRequest('Amount, reference number, and transaction ID are required');
      }
      if (typeof referenceNumber !== 'string' || referenceNumber.length === 0 || referenceNumber.length > 128) {
        return ctx.badRequest('Invalid reference number');
      }
      if (typeof transactionId !== 'string' || transactionId.length === 0 || transactionId.length > 128) {
        return ctx.badRequest('Invalid transaction ID');
      }
      if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) {
        return ctx.badRequest('Invalid notes');
      }

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1_000_000) {
        return ctx.badRequest('Invalid amount');
      }

      // Identity is the JWT, NOT the request body.
      const userId = user.id;
      const userEmail = user.email;
      const userName = user.username || user.email;

      const bankTransferRequest = await strapi.entityService.create('api::bank-transfer-request.bank-transfer-request', {
        data: {
          amount: parsedAmount,
          referenceNumber,
          transactionId,
          notes: typeof notes === 'string' ? notes : '',
          userId,
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
   * Update bank transfer request status (admin-only via global::is-admin policy).
   *
   * Adds idempotency: a 'completed' record cannot be re-completed by a
   * second PUT (pre-fix would have double-credited the wallet because
   * there was no guard around the wallet update — admins double-clicking
   * "Mark complete", or two admins racing, would have led to silent
   * duplicate credits). Status transitions are also gated: once
   * completed or rejected, the record is sealed.
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Bank transfer request not found');
      }

      const { status, notes } = ctx.request.body || {};

      if (!status) {
        return ctx.badRequest('Status is required');
      }

      const validStatuses = ['pending', 'processing', 'completed', 'rejected'];
      if (!validStatuses.includes(status)) {
        return ctx.badRequest('Invalid status');
      }
      if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) {
        return ctx.badRequest('Invalid notes');
      }

      // Lock the row + run the transition atomically so two concurrent
      // PUTs cannot both credit the wallet.
      const result = await strapi.db.transaction(async ({ trx }) => {
        const lockRows = await trx('bank_transfer_requests')
          .where({ id: numericId })
          .forUpdate()
          .select('*');
        if (!lockRows || lockRows.length === 0) {
          return { httpKind: 'notFound' };
        }
        const request = lockRows[0];

        // Sealed-state guard: once completed or rejected, no further changes.
        if (request.status === 'completed' || request.status === 'rejected') {
          if (request.status === status) {
            // Idempotent no-op on identical re-submission.
            return { httpKind: 'ok', updated: request, walletCredited: false, userId: request.user_id };
          }
          return { httpKind: 'badRequest', message: `Cannot transition from ${request.status} to ${status}` };
        }

        const updatedRequest = await strapi.entityService.update(
          'api::bank-transfer-request.bank-transfer-request',
          numericId,
          {
            data: {
              status,
              adminNotes: notes || request.admin_notes,
              updatedAt: new Date(),
            },
          }
        );

        let walletCredited = false;
        let createdTxId = null;
        // Only credit on the SAME transition (pending|processing → completed),
        // never on a redundant completed → completed (idempotency above
        // already returned in that case).
        if (status === 'completed') {
          const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { users_permissions_user: request.user_id },
          });
          if (wallet) {
            const credit = parseFloat(request.amount);
            const newMain = parseFloat(wallet.mainBalance || 0) + credit;
            await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
              data: {
                mainBalance: newMain,
                balance: newMain + parseFloat(wallet.promoBalance || 0),
              },
            });
            const btrTx = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                user_wallet: wallet.id,
                type: 'bank_transfer',
                amount: credit,
                description: `Bank transfer - Reference: ${request.reference_number}`,
                transactionStatus: 'success',
                gatewayTransactionId: `btr_${request.id}`,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
            walletCredited = true;
            createdTxId = btrTx?.id ?? null;
          } else {
            strapi.log?.error?.(`[BANK TRANSFER] no wallet found for user_id=${request.user_id} on completion of btr ${request.id}`);
          }
        }

        return { httpKind: 'ok', updated: updatedRequest, walletCredited, userId: request.user_id, createdTxId };
      });

      if (result.httpKind === 'notFound') {
        return ctx.notFound('Bank transfer request not found');
      }
      if (result.httpKind === 'badRequest') {
        return ctx.badRequest(result.message);
      }
      const updatedRequest = result.updated;
      const request = updatedRequest; // for the email block below

      // Real-time push: emit on the requester's channel only when the wallet
      // actually moved. Fires AFTER the transaction commits so the client
      // never sees a stale balance. Best-effort.
      if (result.walletCredited && result.userId) {
        try {
          await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
            result.userId,
            'bank_transfer',
            { bankTransferRequestId: numericId, amount: parseFloat(request.amount), referenceNumber: request.referenceNumber || request.reference_number }
          );
        } catch (emitErr) {
          strapi.log?.warn?.(`[BANK TRANSFER] emitBalanceUpdate failed (non-fatal): ${emitErr.message}`);
        }

        // Affiliate commission — no-op today because the row above writes
        // type='bank_transfer' (not in the transaction.type enum). Once the
        // row is written correctly as type='deposit' + gateway='bank_transfer',
        // this hook will start awarding commissions with no code change.
        if (result.createdTxId) {
          strapi.service('api::affiliate-commission.affiliate-commission')
            .awardOnDeposit({ depositTransactionId: result.createdTxId })
            .catch((e) => strapi.log?.warn?.(`[BANK TRANSFER] awardOnDeposit failed (non-fatal): ${e.message}`));
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
