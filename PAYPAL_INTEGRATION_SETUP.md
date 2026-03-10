# PayPal Integration Setup Guide

This guide will help you set up a professional PayPal integration for your Serpbays application.

## 🔧 Environment Variables

Add the following environment variables to your `.env` file:

```bash
# PayPal Configuration
PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_CLIENT_SECRET=your_paypal_client_secret
PAYPAL_ENVIRONMENT=sandbox  # or 'live' for production
PAYPAL_WEBHOOK_ID=your_webhook_id
PAYPAL_MERCHANT_ID=your_merchant_id
PAYPAL_BRAND_NAME=Serpbays

# Client URL for return/cancel URLs
CLIENT_URL=http://localhost:3000  # or your production URL
```

## 📋 Setup Steps

### 1. PayPal Developer Account Setup

1. Go to [PayPal Developer Portal](https://developer.paypal.com/)
2. Create a developer account or log in
3. Create a new application:
   - Choose "REST API apps"
   - Select "Default Application" or create a custom app
   - Choose Sandbox for testing or Live for production

### 2. Get API Credentials

1. In your PayPal app dashboard, go to "App Settings"
2. Copy the **Client ID** and **Client Secret**
3. Add these to your `.env` file

### 3. Set Up Webhooks

1. In PayPal Developer Portal, go to your app
2. Click on "Webhooks" in the left sidebar
3. Click "Add Webhook"
4. Set the webhook URL: `https://yourdomain.com/api/transactions/paypal-webhook`
5. Select the following events:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYOUTS.PAYOUT.COMPLETED`
   - `PAYOUTS.PAYOUT.FAILED`
6. Copy the **Webhook ID** and add it to your `.env` file

### 4. Install Dependencies

```bash
cd serpbays_server
npm install @paypal/payouts-sdk
```

### 5. Test the Integration

1. Start your server: `npm run dev`
2. Test PayPal payment flow:
   - Go to wallet page
   - Select PayPal as payment method
   - Enter amount and click "Add Funds"
   - You'll be redirected to PayPal sandbox
   - Complete the payment
   - Check your server logs for webhook events

## 🔒 Security Considerations

### Webhook Verification
- The webhook handler includes signature verification
- In production, implement proper certificate verification
- Always verify webhook signatures before processing

### Environment Security
- Never commit `.env` files to version control
- Use different credentials for sandbox and production
- Rotate API keys regularly

### Data Protection
- Store minimal payment data
- Use PayPal's secure token system
- Implement proper error handling

## 🚀 Production Deployment

### 1. Switch to Live Environment
```bash
PAYPAL_ENVIRONMENT=live
```

### 2. Update Webhook URL
- Update webhook URL to your production domain
- Test webhook delivery in PayPal dashboard

### 3. Monitor Transactions
- Set up logging and monitoring
- Monitor webhook delivery success rates
- Set up alerts for failed payments

## 📊 Features Included

### Payment Processing
- ✅ Create PayPal orders
- ✅ Handle payment completion
- ✅ Process refunds
- ✅ Webhook verification
- ✅ Error handling and retry logic

### Payouts (Withdrawals)
- ✅ Create PayPal payouts
- ✅ Track payout status
- ✅ Handle payout failures
- ✅ Integration with withdrawal system

### Security
- ✅ Webhook signature verification
- ✅ Environment-based configuration
- ✅ Proper error handling
- ✅ Transaction logging

## 🐛 Troubleshooting

### Common Issues

1. **Webhook not receiving events**
   - Check webhook URL is accessible
   - Verify webhook ID is correct
   - Check server logs for errors

2. **Payment not completing**
   - Verify return/cancel URLs are correct
   - Check PayPal order status
   - Review webhook event logs

3. **Payout failures**
   - Verify recipient email is valid
   - Check PayPal account status
   - Review payout error messages

### Debug Mode
Enable debug logging by setting:
```bash
DEBUG=paypal:*
```

## 📚 API Reference

### Payment Flow
1. `POST /api/transactions/payment` - Create payment
2. User completes payment on PayPal
3. PayPal sends webhook to `/api/transactions/paypal-webhook`
4. System processes payment and updates wallet

### Payout Flow
1. Admin approves withdrawal
2. System creates PayPal payout
3. PayPal processes payout
4. Webhook confirms completion/failure

## 🔄 Testing

### Sandbox Testing
- Use PayPal sandbox accounts
- Test all payment scenarios
- Verify webhook handling
- Test refund flows

### Production Testing
- Start with small amounts
- Monitor all transactions
- Test webhook reliability
- Verify payout processing

## 📞 Support

For PayPal-specific issues:
- [PayPal Developer Documentation](https://developer.paypal.com/docs/)
- [PayPal Support](https://www.paypal.com/support)
- [PayPal Developer Community](https://developer.paypal.com/community/)

For integration issues:
- Check server logs
- Review webhook events
- Test with PayPal's webhook simulator
