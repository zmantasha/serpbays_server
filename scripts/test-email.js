const strapi = require('@strapi/strapi');

async function testEmail() {
  try {
    // Initialize Strapi
    const app = strapi({ 
      distDir: './dist',
      autoReload: false,
      serveAdminPanel: false,
    });
    
    await app.load();
    
    console.log('🚀 Strapi loaded successfully');
    
    // Test email configuration
    const testEmail = process.env.TEST_EMAIL || 'test@example.com';
    
    console.log(`📧 Testing email to: ${testEmail}`);
    
    try {
      await strapi.plugin('email').service('email').send({
        to: testEmail,
        from: process.env.EMAIL_FROM || 'noreply@serpbays.com',
        replyTo: process.env.EMAIL_REPLY_TO || 'support@serpbays.com',
        subject: 'SerpBays Email Test',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
            <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #3b82f6; margin: 0;">SerpBays</h1>
                <p style="color: #6b7280; margin: 10px 0 0 0;">Email Test</p>
              </div>
              
              <h2 style="color: #374151; margin-bottom: 20px;">Email Configuration Test</h2>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 25px;">
                If you're reading this email, your SerpBays email configuration is working correctly!
              </p>
              
              <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 15px; margin: 20px 0;">
                <h3 style="color: #15803d; margin: 0 0 10px 0;">✅ Email Configuration Status</h3>
                <ul style="color: #166534; margin: 0; padding-left: 20px;">
                  <li>SMTP connection successful</li>
                  <li>Email templates working</li>
                  <li>Authentication configured</li>
                </ul>
              </div>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                <strong>Test Details:</strong><br>
                • Sent at: ${new Date().toISOString()}<br>
                • From: ${process.env.EMAIL_FROM || 'noreply@serpbays.com'}<br>
                • SMTP Host: ${process.env.SMTP_HOST || 'smtp.gmail.com'}<br>
                • Port: ${process.env.SMTP_PORT || '587'}
              </p>
              
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
              
              <p style="color: #9ca3af; font-size: 14px; text-align: center;">
                This is an automated test email from SerpBays.
              </p>
            </div>
          </div>
        `,
      });
      
      console.log('✅ Test email sent successfully!');
      console.log('📬 Check your inbox for the test email');
      
    } catch (emailError) {
      console.error('❌ Email sending failed:', emailError.message);
      console.log('\n🔧 Troubleshooting tips:');
      console.log('1. Check your SMTP credentials in .env file');
      console.log('2. Ensure 2FA is enabled and you\'re using an app password (for Gmail)');
      console.log('3. Verify firewall/network settings');
      console.log('4. Check SMTP server settings');
    }
    
    await app.destroy();
    console.log('🏁 Test completed');
    
  } catch (error) {
    console.error('❌ Error during email test:', error);
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  // Get test email from command line argument or use default
  if (process.argv[2]) {
    process.env.TEST_EMAIL = process.argv[2];
  }
  
  testEmail();
}

module.exports = testEmail; 