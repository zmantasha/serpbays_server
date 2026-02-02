# AutoSend Email Integration - Environment Setup

## Required Environment Variables

Add the following to your `.env` file:

```bash
# ============================================
# AutoSend Email Configuration
# ============================================
# Get your API key from: https://autosend.com/dashboard
AUTOSEND_API_KEY=your_autosend_api_key_here

# Email Sender Information
EMAIL_FROM=noreply@serpbays.com
EMAIL_REPLY_TO=support@serpbays.com

# Client URL (for email links)
CLIENT_URL=http://localhost:3000
```

## Setup Instructions

### 1. Get AutoSend API Key

1. Visit [autosend.com](https://autosend.com/signup)
2. Create an account or log in
3. Navigate to Dashboard → API Settings
4. Copy your API key

### 2. Update .env File

Add your AutoSend API key to `serpbays_server/.env`:

```bash
AUTOSEND_API_KEY=sk_live_your_actual_key_here
```

### 3. Verify Domain (Production)

For production use, you should verify your sending domain in AutoSend:

1. Log into AutoSend dashboard
2. Go to Settings → Domains
3. Add `serpbays.com`
4. Add the DNS records provided by AutoSend
5. Wait for verification

### 4. Restart Server

```bash
cd serpbays_server
npm run develop
```

## Deprecated Environment Variables

The following SMTP variables are **no longer needed** and can be removed from your `.env`:

- ~~`SMTP_HOST`~~
- ~~`SMTP_PORT`~~
- ~~`SMTP_USERNAME`~~
- ~~`SMTP_PASSWORD`~~

## Testing

Send a test email to verify the integration:

```bash
# From serpbays_server directory
npm run email:test
```

Or manually trigger an order email by creating a test order in the application.

## Monitoring

View email delivery status in the AutoSend dashboard:
- Delivery rate
- Open rate
- Click rate
- Bounce/spam reports

## Troubleshooting

### Error: "AUTOSEND_API_KEY not configured"

**Solution:** Make sure you've added `AUTOSEND_API_KEY` to your `.env` file and restarted the server.

### Emails not being delivered

**Solutions:**
1. Check AutoSend dashboard for delivery status
2. Verify your API key is correct
3. Check if domain is verified (for production)
4. Review server logs for AutoSend errors

### API Key Issues

If you see authentication errors:
1. Verify the API key is correct in `.env`
2. Check if the key has been revoked in AutoSend dashboard
3. Ensure no extra spaces in the `.env` value
