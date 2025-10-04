# Razorpay Webhook Verification Guide

This guide helps you verify that Razorpay webhooks are correctly updating transaction status from "pending" to "success".

## ✅ Current Implementation

Your system automatically updates transaction status through webhooks:

1. **Payment Created** → Transaction created with `status: "pending"`
2. **Payment Successful** → Razorpay sends webhook → Status updated to `"success"` + Wallet balance updated
3. **Payment Failed** → Razorpay sends webhook → Status updated to `"failed"`

## 🧪 How to Test

### Method 1: Check Specific Transaction (Recommended)

Use the test script to check if a specific transaction has been updated:

```bash
# Using the order ID from your screenshot
node test-webhook-status.js order_RPKeiCHXnA5GJE
```

This will show you:
- Current transaction status
- Whether webhook has updated it
- Wallet association
- Metadata

### Method 2: Check Razorpay Dashboard Webhook Logs

1. Go to **Razorpay Dashboard** → **Settings** → **Webhooks**
2. Click on your webhook URL
3. Check the **Logs** tab
4. Look for recent deliveries:
   - ✅ **Green checkmark** = Webhook delivered successfully
   - ❌ **Red X** = Webhook failed (check error)

### Method 3: Monitor Server Logs in Real-Time

```bash
# In your server directory, watch logs as you make a test payment
tail -f server.log | grep -i "razorpay\|webhook"
```

You should see logs like:
```
[RAZORPAY WEBHOOK] Received webhook: payment.captured
[RAZORPAY WEBHOOK] Payment captured: pay_xxxxx for order order_xxxxx
[RAZORPAY WEBHOOK] ✅ Successfully processed payment pay_xxxxx
```

### Method 4: Direct Database Check

```bash
# Connect to your Strapi admin panel
# Go to Content Manager → Transactions
# Find the transaction by gatewayTransactionId: order_RPKeiCHXnA5GJE
# Check if transactionStatus changed from "pending" to "success"
```

## 🔍 Troubleshooting

### Issue: Transaction Status Not Updating

**Symptoms:**
- Transaction stays "pending" even after successful payment
- Wallet balance not updated

**Solutions:**

#### 1. Verify Webhook URL is Reachable

```bash
# Your webhook URL should be publicly accessible
curl -X POST https://your-domain.com/api/transactions/razorpay-webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"test"}'
```

Expected: Should return `200 OK` or `400 Bad Request` (not 404 or timeout)

#### 2. Check Environment Variables

Ensure these are set in your `.env`:
```bash
RAZORPAY_KEY_ID=rzp_test_xxxxx          # ✅ Required
RAZORPAY_KEY_SECRET=xxxxx               # ✅ Required  
RAZORPAY_WEBHOOK_SECRET=xxxxx           # ✅ Required for webhook verification
```

#### 3. Check Razorpay Webhook Configuration

Go to **Razorpay Dashboard** → **Settings** → **Webhooks**

Required webhook URL:
```
https://your-domain.com/api/transactions/razorpay-webhook
```

Required events (select these):
- ✅ `payment.captured`
- ✅ `payment.failed`
- ✅ `order.paid`

#### 4. Test with Razorpay Test Mode

Make sure you're using test credentials when testing:
- Test Key ID starts with `rzp_test_`
- Use test card: `4111 1111 1111 1111`
- Any CVV, future expiry date

#### 5. Check Server Logs for Errors

```bash
# Check for webhook errors
grep -i "razorpay webhook.*error" server.log

# Check for signature verification errors
grep -i "invalid signature" server.log
```

#### 6. Manually Trigger Webhook (Testing)

You can manually send a test webhook to your server:

```bash
# Replace with your actual values
curl -X POST http://localhost:1337/api/transactions/razorpay-webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: test_signature" \
  -d '{
    "event": "payment.captured",
    "payload": {
      "payment": {
        "entity": {
          "id": "pay_test123",
          "order_id": "order_RPKeiCHXnA5GJE",
          "amount": 30000,
          "currency": "USD",
          "status": "captured"
        }
      }
    }
  }'
```

**Note:** This will fail signature verification unless you disable it temporarily or calculate the correct signature.

## 🎯 Expected Webhook Flow

### 1. Payment Success

```
User makes payment 
    ↓
Razorpay processes payment
    ↓
Razorpay sends webhook: payment.captured
    ↓
Your server receives webhook at /api/transactions/razorpay-webhook
    ↓
Webhook handler verifies signature
    ↓
Finds transaction by gatewayTransactionId
    ↓
Updates transactionStatus: "pending" → "success"
    ↓
Adds amount to wallet mainBalance
    ↓
Returns success response
```

### 2. What Happens in Database

**Before webhook:**
```json
{
  "transactionStatus": "pending",
  "gatewayTransactionId": "order_RPKeiCHXnA5GJE",
  "amount": 300,
  "external_transaction_id": null
}
```

**After webhook:**
```json
{
  "transactionStatus": "success",
  "gatewayTransactionId": "order_RPKeiCHXnA5GJE", 
  "amount": 300,
  "external_transaction_id": "pay_xxxxxx"  // Razorpay payment ID
}
```

**Wallet Update:**
```json
{
  "mainBalance": 86 + 300 = 386,
  "balance": 386 + promoBalance
}
```

## 📊 Common Scenarios

### Scenario 1: Everything Working ✅
- Transaction created with "pending"
- User completes payment
- Within 1-5 seconds, webhook fires
- Transaction status → "success"
- Wallet balance increased
- User sees updated balance in UI

### Scenario 2: Webhook Delayed ⏳
- Transaction created with "pending"
- User completes payment
- Webhook takes 10-30 seconds (Razorpay retry)
- Eventually updates to "success"
- **Solution:** Implement client-side polling or use verify endpoint

### Scenario 3: Webhook Failed ❌
- Transaction created with "pending"
- User completes payment
- Webhook never reaches your server (firewall, URL wrong, server down)
- Status stays "pending" forever
- **Solution:** Check Razorpay webhook logs, verify URL is accessible

### Scenario 4: Signature Mismatch 🔒
- Transaction created with "pending"
- Webhook reaches server
- Signature verification fails
- Server rejects webhook (403 Forbidden)
- Status stays "pending"
- **Solution:** Verify RAZORPAY_WEBHOOK_SECRET matches Razorpay dashboard

## 🔧 Manual Status Update (Emergency Only)

If webhook fails and you need to manually update transaction status:

```javascript
// Use Strapi Admin Panel or run this query
await strapi.db.query('api::transaction.transaction').update({
  where: { gatewayTransactionId: 'order_RPKeiCHXnA5GJE' },
  data: { 
    transactionStatus: 'success',
    external_transaction_id: 'pay_xxxxxx', // Get from Razorpay dashboard
    updatedAt: new Date()
  }
});

// Then manually update wallet balance
const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
  where: { id: walletId }
});

await strapi.db.query('api::user-wallet.user-wallet').update({
  where: { id: walletId },
  data: {
    mainBalance: parseFloat(wallet.mainBalance) + 300, // Add amount
    balance: parseFloat(wallet.balance) + 300,
    updatedAt: new Date()
  }
});
```

⚠️ **Warning:** This bypasses the normal webhook flow. Only use in emergencies.

## 📝 Quick Checklist

Before asking "why isn't my transaction updating?", check:

- [ ] Transaction exists in database with correct `gatewayTransactionId`
- [ ] Payment was actually successful in Razorpay dashboard
- [ ] Webhook URL is configured in Razorpay dashboard
- [ ] Webhook URL is publicly accessible (not localhost, not blocked)
- [ ] `RAZORPAY_WEBHOOK_SECRET` is set in `.env`
- [ ] Webhook secret in `.env` matches Razorpay dashboard
- [ ] Events `payment.captured`, `payment.failed`, `order.paid` are enabled
- [ ] Server is running and accessible
- [ ] No errors in server logs
- [ ] Razorpay webhook logs show successful delivery (green checkmark)

## 🎓 Understanding the Flow

**Why two verification methods?**

1. **Webhook** (`/api/transactions/razorpay-webhook`) - **PRIMARY**
   - Razorpay sends this automatically
   - Most reliable for updating status
   - Happens server-to-server
   - Works even if user closes browser

2. **Verify Payment** (`/api/transactions/verify-razorpay`) - **SECONDARY**
   - Client calls this after payment
   - Only verifies signature, doesn't update wallet
   - Used for instant UI feedback
   - Prevents race conditions with webhook

**Best Practice:** Use webhook for actual updates, use verify endpoint for UI feedback.

## 🆘 Still Not Working?

1. **Check this transaction specifically:**
   ```bash
   node test-webhook-status.js order_RPKeiCHXnA5GJE
   ```

2. **Enable webhook debugging:**
   - Temporarily add more logging in `razorpay-webhook.js`
   - Use a service like [webhook.site](https://webhook.site) to test webhook delivery

3. **Test in Razorpay Dashboard:**
   - Go to Webhooks → Your webhook → Test
   - Send a test `payment.captured` event
   - Check if your server receives it

4. **Contact Razorpay Support:**
   - If webhooks aren't being sent at all
   - If delivery consistently fails

