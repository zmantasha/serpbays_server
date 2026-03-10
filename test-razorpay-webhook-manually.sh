#!/bin/bash

# Manual Razorpay Webhook Test Script
# This script manually sends a webhook payload to test if your webhook handler works
#
# Usage: ./test-razorpay-webhook-manually.sh [order_id]

ORDER_ID="${1:-order_RPKeiCHXnA5GJE}"
SERVER_URL="${2:-http://localhost:1337}"

echo "🧪 Testing Razorpay Webhook Handler"
echo "═════════════════════════════════════════════════════════════"
echo "Order ID: $ORDER_ID"
echo "Server URL: $SERVER_URL"
echo "═════════════════════════════════════════════════════════════"
echo ""

# Test 1: Check if server is running
echo "1️⃣  Checking if Strapi server is running..."
if curl -s --max-time 5 "$SERVER_URL/_health" > /dev/null 2>&1; then
    echo "✅ Server is running"
else
    echo "❌ Server is not responding at $SERVER_URL"
    echo "   Please start your Strapi server with: npm run develop"
    exit 1
fi
echo ""

# Test 2: Send a test webhook (this will fail signature verification but will show if endpoint is reachable)
echo "2️⃣  Testing webhook endpoint accessibility..."
WEBHOOK_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
  "$SERVER_URL/api/transactions/razorpay-webhook" \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: test_signature_will_fail" \
  -d "{
    \"event\": \"payment.captured\",
    \"payload\": {
      \"payment\": {
        \"entity\": {
          \"id\": \"pay_test123\",
          \"order_id\": \"$ORDER_ID\",
          \"amount\": 30000,
          \"currency\": \"USD\",
          \"status\": \"captured\"
        }
      }
    }
  }")

HTTP_STATUS=$(echo "$WEBHOOK_RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
RESPONSE_BODY=$(echo "$WEBHOOK_RESPONSE" | sed '/HTTP_STATUS/d')

echo "Response Status: $HTTP_STATUS"
echo "Response Body: $RESPONSE_BODY"
echo ""

if [ "$HTTP_STATUS" = "403" ] || [ "$HTTP_STATUS" = "401" ]; then
    echo "✅ Webhook endpoint is accessible (signature verification working)"
    echo "   Status 403/401 is expected because we sent a test signature"
elif [ "$HTTP_STATUS" = "200" ]; then
    echo "✅ Webhook endpoint processed successfully"
    echo "   (Note: RAZORPAY_WEBHOOK_SECRET might not be configured)"
elif [ "$HTTP_STATUS" = "404" ]; then
    echo "❌ Webhook endpoint not found (404)"
    echo "   Check that route exists in transaction routes"
else
    echo "⚠️  Unexpected status code: $HTTP_STATUS"
fi

echo ""
echo "═════════════════════════════════════════════════════════════"
echo "📋 Next Steps:"
echo "═════════════════════════════════════════════════════════════"
echo ""
echo "To check the transaction status:"
echo "1. Open Strapi Admin Panel: $SERVER_URL/admin"
echo "2. Go to: Content Manager > Transaction"
echo "3. Search for: $ORDER_ID"
echo "4. Check the 'transactionStatus' field"
echo ""
echo "Expected statuses:"
echo "  • pending  = Transaction created, waiting for webhook"
echo "  • success  = Webhook updated successfully ✅"
echo "  • failed   = Payment failed ❌"
echo ""
echo "To check Razorpay webhook delivery:"
echo "1. Login to Razorpay Dashboard"
echo "2. Go to: Settings > Webhooks"
echo "3. Click on your webhook URL"
echo "4. Check 'Logs' tab for recent deliveries"
echo "   - Green checkmark ✅ = Delivered successfully"
echo "   - Red X ❌ = Delivery failed (check error)"
echo ""
echo "To monitor webhook in real-time:"
echo "  tail -f server.log | grep -i 'razorpay'"
echo ""

