# PayPal Integration - URGENT Security Fixes Required

## ⚠️ DO NOT DEPLOY TO PRODUCTION WITHOUT THESE FIXES

### 1. Enable Webhook Signature Verification (30 minutes)

**File:** `src/api/transaction/services/paypal.js`

Replace the `verifyWebhookSignature` function:

```javascript
async verifyWebhookSignature(headers, body, webhookId) {
  try {
    // Get access token
    const tokenResponse = await this.getAccessToken();
    
    // Call PayPal's verification endpoint
    const response = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenResponse.accessToken}`
      },
      body: JSON.stringify({
        transmission_id: headers['paypal-transmission-id'],
        transmission_time: headers['paypal-transmission-time'],
        cert_url: headers['paypal-cert-url'],
        auth_algo: headers['paypal-auth-algo'],
        transmission_sig: headers['paypal-transmission-sig'],
        webhook_id: webhookId,
        webhook_event: typeof body === 'string' ? JSON.parse(body) : body
      })
    });

    const verification = await response.json();
    
    return {
      success: true,
      verified: verification.verification_status === 'SUCCESS'
    };
  } catch (error) {
    console.error('PayPal webhook verification error:', error);
    return {
      success: false,
      verified: false,
      error: error.message
    };
  }
}
```

**File:** `src/api/transaction/controllers/paypal-webhook.js`

Update webhook handler to REJECT unverified webhooks:

```javascript
// Replace lines 23-44 with:
const webhookId = process.env.PAYPAL_WEBHOOK_ID;
if (!webhookId) {
  console.error('[PAYPAL WEBHOOK] PAYPAL_WEBHOOK_ID not configured');
  return ctx.badRequest('Webhook ID not configured');
}

const verification = await strapi.service('api::transaction.payment').verifyPayPalWebhook(
  headers, 
  JSON.stringify(body), 
  webhookId
);

if (!verification.verified) {
  console.error('[PAYPAL WEBHOOK] Webhook verification FAILED - REJECTING REQUEST');
  return ctx.forbidden('Webhook verification failed');
}

console.log('[PAYPAL WEBHOOK] ✅ Webhook verification successful');
```

---

### 2. Add Environment Variable Validation (15 minutes)

**File:** `src/api/transaction/services/paypal.js`

Add at the top of the file (after imports, before environment setup):

```javascript
// Validate PayPal configuration
function validatePayPalConfig() {
  const required = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'CLIENT_URL'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`❌ Missing required PayPal environment variables: ${missing.join(', ')}`);
  }

  const env = process.env.PAYPAL_ENVIRONMENT || 'sandbox';
  if (!['sandbox', 'live'].includes(env)) {
    throw new Error(`❌ Invalid PAYPAL_ENVIRONMENT: ${env}. Must be 'sandbox' or 'live'`);
  }

  if (process.env.NODE_ENV === 'production' && env === 'sandbox') {
    console.warn('⚠️  WARNING: Using PayPal SANDBOX in PRODUCTION! Set PAYPAL_ENVIRONMENT=live');
  }

  console.log(`✅ PayPal configured: ${env.toUpperCase()} environment`);
}

// Call validation
validatePayPalConfig();
```

---

### 3. Fix Idempotency - Prevent Duplicate Transactions (20 minutes)

**Database Migration:** Create migration file:

```javascript
// database/migrations/add-unique-gateway-transaction-id.js
module.exports = {
  async up(knex) {
    // Add unique constraint
    await knex.schema.alterTable('transactions', (table) => {
      table.unique(['gatewayTransactionId'], 'unique_gateway_transaction_id');
    });
  },

  async down(knex) {
    await knex.schema.alterTable('transactions', (table) => {
      table.dropUnique(['gatewayTransactionId'], 'unique_gateway_transaction_id');
    });
  }
};
```

**File:** `src/api/transaction/controllers/paypal-webhook.js`

Update `handlePaymentCompleted`:

```javascript
async handlePaymentCompleted(eventData) {
  try {
    const capture = eventData.resource;
    const captureId = capture.id;
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    
    console.log(`[PAYPAL WEBHOOK] Payment completed - Capture: ${captureId}, Order: ${orderId}`);

    if (!orderId) {
      console.error('[PAYPAL WEBHOOK] No order ID found');
      return;
    }

    // Use try-catch to handle duplicate transactions gracefully
    try {
      // Check for existing transaction (with both IDs)
      const existing = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          $or: [
            { gatewayTransactionId: captureId },
            { gatewayTransactionId: orderId }
          ]
        }
      });

      if (existing) {
        console.log(`[PAYPAL WEBHOOK] ⚠️  Transaction already processed: ${captureId}`);
        return; // Idempotent - exit early
      }

      // Get order details
      const orderDetails = await strapi.service('api::transaction.payment').getPayPalOrderDetails(orderId);
      
      if (!orderDetails.success) {
        throw new Error('Failed to get order details');
      }

      const order = orderDetails.order;
      const purchaseUnit = order.purchase_units[0];
      const amount = parseFloat(purchaseUnit.amount.value);
      const customId = purchaseUnit.custom_id;
      const walletId = customId ? parseInt(customId) : null;

      if (!walletId) {
        throw new Error('No wallet ID found in order');
      }

      // Find wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId }
      });

      if (!wallet) {
        throw new Error(`Wallet not found: ${walletId}`);
      }

      // Update wallet balance
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const newMainBalance = currentMainBalance + amount;
      const newTotalBalance = newMainBalance + currentPromoBalance;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: walletId },
        data: { 
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });

      console.log(`[PAYPAL WEBHOOK] 💵 Wallet updated: Main=${currentMainBalance} + ${amount} = ${newMainBalance}`);

      // Create transaction record
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          transactionStatus: 'success',
          gateway: 'paypal',
          gatewayTransactionId: captureId, // Use capture ID as primary identifier
          description: `PayPal payment - Order ${orderId}`,
          user_wallet: walletId,
          users_permissions_user: wallet.users_permissions_user,
          fund_source: 'main_fund',
          fee: 0,
          metadata: {
            orderId: orderId,
            captureId: captureId,
            payerEmail: order.payer?.email_address,
            currency: purchaseUnit.amount.currency_code
          },
          publishedAt: new Date()
        }
      });

      console.log(`[PAYPAL WEBHOOK] ✅ Payment processed - Wallet ${walletId} updated with $${amount}`);

    } catch (dbError) {
      // Check if it's a duplicate key error
      if (dbError.code === 'ER_DUP_ENTRY' || dbError.code === '23505') {
        console.log(`[PAYPAL WEBHOOK] ⚠️  Duplicate transaction detected (concurrent webhook) - ${captureId}`);
        return; // Idempotent - another webhook already processed this
      }
      throw dbError; // Re-throw other errors
    }

  } catch (error) {
    console.error('[PAYPAL WEBHOOK] Error handling payment completed:', error);
  }
}
```

---

### 4. Fix Refund Balance Handling (15 minutes)

**File:** `src/api/transaction/controllers/paypal-webhook.js`

Replace `handlePaymentRefunded` function:

```javascript
async handlePaymentRefunded(eventData) {
  try {
    const refund = eventData.resource;
    const refundId = refund.id;
    const refundAmount = parseFloat(refund.amount.value);
    const captureId = refund.supplementary_data?.related_ids?.capture_id;
    
    console.log(`[PAYPAL WEBHOOK] Processing refund: ${refundId}, Amount: $${refundAmount}`);
    
    // Find original transaction
    const originalTransaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: captureId }
    });

    if (!originalTransaction) {
      console.error(`[PAYPAL WEBHOOK] Original transaction not found for capture: ${captureId}`);
      return;
    }

    // Check for duplicate refund
    const existingRefund = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: refundId }
    });

    if (existingRefund) {
      console.log(`[PAYPAL WEBHOOK] Refund already processed: ${refundId}`);
      return;
    }

    // Find wallet
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { id: originalTransaction.user_wallet }
    });

    if (!wallet) {
      console.error(`[PAYPAL WEBHOOK] Wallet not found: ${originalTransaction.user_wallet}`);
      return;
    }

    // Determine fund source from original transaction
    const fundSource = originalTransaction.fund_source || 'main_fund';
    
    // Deduct from correct balance
    if (fundSource === 'main_fund') {
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      
      if (currentMainBalance < refundAmount) {
        console.error(`[PAYPAL WEBHOOK] ❌ Insufficient main balance for refund`);
        console.error(`Required: $${refundAmount}, Available: $${currentMainBalance}`);
        
        // Send alert to admin
        await strapi.entityService.create('api::admin-alert.admin-alert', {
          data: {
            type: 'insufficient_balance_refund',
            severity: 'high',
            title: 'PayPal Refund - Insufficient Balance',
            message: `Cannot process refund of $${refundAmount}. Wallet ${wallet.id} has only $${currentMainBalance} in main balance.`,
            metadata: { refundId, captureId, walletId: wallet.id },
            publishedAt: new Date()
          }
        });
        return;
      }
      
      const newMainBalance = currentMainBalance - refundAmount;
      const newTotalBalance = newMainBalance + currentPromoBalance;
      
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: wallet.id },
        data: { 
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });
      
      console.log(`[PAYPAL WEBHOOK] 💵 Main balance updated: ${currentMainBalance} - ${refundAmount} = ${newMainBalance}`);
    } else {
      // Handle promo balance refund (if applicable)
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      
      if (currentPromoBalance < refundAmount) {
        console.error(`[PAYPAL WEBHOOK] ❌ Insufficient promo balance for refund`);
        return;
      }
      
      const newPromoBalance = currentPromoBalance - refundAmount;
      const newTotalBalance = currentMainBalance + newPromoBalance;
      
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: wallet.id },
        data: { 
          promoBalance: newPromoBalance,
          balance: newTotalBalance
        }
      });
    }

    // Create refund transaction
    await strapi.entityService.create('api::transaction.transaction', {
      data: {
        type: 'refund',
        amount: refundAmount,
        netAmount: refundAmount,
        transactionStatus: 'success',
        gateway: 'paypal',
        gatewayTransactionId: refundId,
        description: `PayPal refund - ${refund.note_to_payer || 'Refund processed'}`,
        user_wallet: wallet.id,
        users_permissions_user: originalTransaction.users_permissions_user,
        fund_source: fundSource,
        fee: 0,
        metadata: {
          originalCaptureId: captureId,
          refundId: refundId,
          reason: refund.note_to_payer
        },
        publishedAt: new Date()
      }
    });

    console.log(`[PAYPAL WEBHOOK] ✅ Refund processed - Wallet ${wallet.id} updated with -$${refundAmount}`);

  } catch (error) {
    console.error('[PAYPAL WEBHOOK] Error handling payment refunded:', error);
  }
}
```

---

## Testing Checklist

After implementing these fixes, test:

1. **Webhook Verification:**
   ```bash
   # Send a test webhook from PayPal dashboard
   # Should see: "✅ Webhook verification successful"
   ```

2. **Duplicate Webhooks:**
   ```bash
   # Send the same webhook twice quickly
   # Second one should log: "⚠️ Transaction already processed"
   ```

3. **Missing Config:**
   ```bash
   # Remove PAYPAL_CLIENT_ID from .env
   # Restart server - should throw error immediately
   ```

4. **Refund with Insufficient Balance:**
   ```bash
   # Manually reduce wallet balance
   # Trigger refund - should create admin alert
   ```

---

## Environment Variables Checklist

Ensure these are set in your `.env`:

```bash
# Required
PAYPAL_CLIENT_ID=your_client_id
PAYPAL_CLIENT_SECRET=your_client_secret
PAYPAL_WEBHOOK_ID=your_webhook_id
CLIENT_URL=http://localhost:3000

# Optional but recommended
PAYPAL_ENVIRONMENT=sandbox  # or 'live' for production
PAYPAL_MERCHANT_ID=your_merchant_id
PAYPAL_BRAND_NAME=Serpbays
```

---

## After Fixes, Run:

```bash
# 1. Run database migration
cd serpbays_server
npm run strapi migrations:run

# 2. Restart server
npm run develop

# 3. Test webhook signature verification
# Use PayPal webhook simulator: https://developer.paypal.com/tools/webhook-simulator/

# 4. Monitor logs
tail -f server.log | grep "PAYPAL WEBHOOK"
```

---

## Emergency Rollback Plan

If issues occur after deployment:

1. **Disable webhook processing temporarily:**
   ```javascript
   // In paypal-webhook.js handleWebhook:
   console.log('[PAYPAL WEBHOOK] Processing disabled for maintenance');
   return ctx.send({ success: true });
   ```

2. **Process webhooks manually:**
   - Check PayPal dashboard for transaction details
   - Manually update wallet balances
   - Create transaction records

3. **Contact PayPal support:**
   - Phone: 1-888-221-1161
   - Email: developer-support@paypal.com

---

## Questions?

Review the full analysis document: `PAYPAL_INTEGRATION_REVIEW.md`

**Estimated Total Time:** 80 minutes  
**Critical for Production:** YES  
**Can be deployed without?** NO


