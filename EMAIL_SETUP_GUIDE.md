# 📧 Email Setup Guide for SerpBays

This guide will help you fix the email issues and enable email verification for user registration.

## 🔧 **Step 1: Configure Environment Variables**

Create a `.env` file in the `serpbays_server` directory with the following configuration:

```bash
# Server Configuration
HOST=0.0.0.0
PORT=1337
APP_KEYS=your-app-keys-here
API_TOKEN_SALT=your-api-token-salt
ADMIN_JWT_SECRET=your-admin-jwt-secret
TRANSFER_TOKEN_SALT=your-transfer-token-salt
JWT_SECRET=your-jwt-secret

# Database
DATABASE_CLIENT=sqlite
DATABASE_FILENAME=.tmp/data.db

# Email Configuration (Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-gmail@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_FROM=noreply@serpbays.com
EMAIL_REPLY_TO=support@serpbays.com

# Client URL (for email links)
CLIENT_URL=http://localhost:3000
```

## 🔐 **Step 2: Set Up Gmail App Password**

### For Gmail (Recommended for Development):

1. **Enable 2-Factor Authentication**:
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Enable 2-Step Verification

2. **Generate App Password**:
   - In Google Account settings, go to Security
   - Under "2-Step Verification", click on "App passwords"
   - Select "Mail" and generate a password
   - Use this 16-character password in `SMTP_PASSWORD`

3. **Update your .env**:
   ```bash
   SMTP_USERNAME=your-gmail@gmail.com
   SMTP_PASSWORD=abcd-efgh-ijkl-mnop  # The app password from step 2
   ```

## 🚀 **Step 3: Enable Email Confirmation**

Run the setup script to enable email confirmation:

```bash
npm run email:setup
```

This script will:
- Enable email confirmation for new registrations
- Configure email templates for verification and password reset
- Set up proper redirect URLs

## ✅ **Step 4: Test Email Configuration**

Test if emails are working:

```bash
npm run email:test your-email@gmail.com
```

Or without specifying an email (will use test@example.com):
```bash
npm run email:test
```

## 🏃‍♂️ **Step 5: Start the Server**

```bash
npm run develop
```

## 🔄 **Step 6: Verify Admin Settings**

1. Open Strapi Admin: `http://localhost:1337/admin`
2. Go to **Settings** → **Users & Permissions plugin** → **Advanced Settings**
3. Verify these settings:
   - ✅ **Enable email confirmation** should be checked
   - **Confirmation page**: Should be set to your frontend URL
   - **Default role for authenticated users**: Should be "Authenticated"

## 📧 **What's Fixed:**

### ✅ Email Verification for Registration
- New users must verify their email before they can log in
- Beautiful email templates with SerpBays branding
- Secure confirmation links that expire

### ✅ Password Reset Emails
- Forgot password functionality now sends emails
- Professional email templates
- 1-hour expiration for security

### ✅ Email Templates
- Custom HTML templates with SerpBays branding
- Mobile-responsive design
- Clear call-to-action buttons

## 🔍 **Testing the Complete Flow:**

### Test Registration:
1. Go to `http://localhost:3000/register`
2. Register with a real email address
3. Check your email for the verification link
4. Click the link to verify your account

### Test Password Reset:
1. Go to `http://localhost:3000/login`
2. Click "Forgot Password?"
3. Enter your email address
4. Check your email for the reset link
5. Click the link to reset your password

## 🐛 **Troubleshooting:**

### "Gmail authentication failed"
- Ensure 2FA is enabled on your Gmail account
- Use App Password, not your regular Gmail password
- Check that SMTP_USERNAME is correct

### "Connection timeout"
- Check firewall settings
- Try port 465 with `secure: true`
- Verify your internet connection

### "Email not received"
- Check spam/junk folder
- Verify email address is correct
- Check server logs for errors

### "Invalid verification link"
- Links expire after a certain time
- Make sure CLIENT_URL is correct
- Check if the user is already verified

## 🌐 **For Production:**

### Use a Professional Email Service:

**SendGrid (Recommended):**
```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USERNAME=apikey
SMTP_PASSWORD=your-sendgrid-api-key
```

**Mailgun:**
```bash
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USERNAME=your-mailgun-username
SMTP_PASSWORD=your-mailgun-password
```

**AWS SES:**
```bash
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USERNAME=your-ses-username
SMTP_PASSWORD=your-ses-password
```

## 📝 **Additional Notes:**

- **Development**: Email URLs are logged to console if sending fails
- **Security**: Reset tokens expire in 1 hour
- **Templates**: Email templates are stored in Strapi admin settings
- **Customization**: Edit templates in Settings → Email Templates

## 🎉 **Success Indicators:**

- ✅ New registrations require email verification
- ✅ Users receive welcome emails with verification links  
- ✅ Password reset emails are sent successfully
- ✅ Email templates have SerpBays branding
- ✅ No more "pending verification" status issues

---

Need help? Check the console logs when testing or contact support! 