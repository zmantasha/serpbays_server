const strapi = require('@strapi/strapi');

async function enableEmailConfirmation() {
  try {
    // Initialize Strapi
    const app = strapi({ 
      distDir: './dist',
      autoReload: false,
      serveAdminPanel: false,
    });
    
    await app.load();
    
    console.log('🚀 Strapi loaded successfully');
    
    // Get the plugin store
    const pluginStore = strapi.store({
      type: 'plugin',
      name: 'users-permissions',
    });
    
    // Get current advanced settings
    const advancedSettings = await pluginStore.get({ key: 'advanced' });
    
    console.log('📧 Current email confirmation setting:', advancedSettings.email_confirmation);
    
    // Enable email confirmation
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        email_confirmation: true,
        email_confirmation_redirection: process.env.CLIENT_URL || 'http://localhost:3000',
      },
    });
    
    console.log('✅ Email confirmation enabled successfully');
    console.log('🔗 Confirmation redirection URL:', process.env.CLIENT_URL || 'http://localhost:3000');
    
    // Configure email templates
    const emailSettings = await pluginStore.get({ key: 'email' }) || {};
    
    await pluginStore.set({
      key: 'email',
      value: {
        ...emailSettings,
        email_confirmation: {
          display: 'Email confirmation',
          icon: 'check-square',
          from: {
            name: 'SerpBays',
            email: process.env.EMAIL_FROM || 'noreply@serpbays.com',
          },
          response_email: process.env.EMAIL_REPLY_TO || 'support@serpbays.com',
          object: 'Welcome to SerpBays - Please confirm your email',
          message: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
              <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #3b82f6; margin: 0;">SerpBays</h1>
                  <p style="color: #6b7280; margin: 10px 0 0 0;">Welcome to the platform!</p>
                </div>
                
                <h2 style="color: #374151; margin-bottom: 20px;">Hello <%= username %>!</h2>
                
                <p style="color: #6b7280; line-height: 1.6; margin-bottom: 25px;">
                  Thank you for joining SerpBays! To complete your registration and start using our platform,
                  please confirm your email address by clicking the button below:
                </p>
                
                <div style="text-align: center; margin: 30px 0;">
                  <a href="<%= URL %>?confirmation=<%= CODE %>" 
                     style="background: #3b82f6; color: white; padding: 12px 30px; 
                            text-decoration: none; border-radius: 6px; font-weight: bold;
                            display: inline-block;">
                    Confirm My Email
                  </a>
                </div>
                
                <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                  Once confirmed, you'll be able to access all features of SerpBays including:
                </p>
                
                <ul style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                  <li>Browse and purchase high-quality content</li>
                  <li>Manage your projects and orders</li>
                  <li>Access our marketplace of websites</li>
                  <li>Track your earnings and analytics</li>
                </ul>
                
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
                
                <p style="color: #9ca3af; font-size: 14px; text-align: center;">
                  If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="<%= URL %>?confirmation=<%= CODE %>" style="color: #3b82f6;"><%= URL %>?confirmation=<%= CODE %></a>
                </p>
                
                <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 20px;">
                  If you didn't create an account with SerpBays, you can safely ignore this email.
                </p>
              </div>
            </div>
          `,
        },
        reset_password: {
          display: 'Reset password',
          icon: 'key',
          from: {
            name: 'SerpBays',
            email: process.env.EMAIL_FROM || 'noreply@serpbays.com',
          },
          response_email: process.env.EMAIL_REPLY_TO || 'support@serpbays.com',
          object: 'Reset Your SerpBays Password',
          message: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
              <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #3b82f6; margin: 0;">SerpBays</h1>
                  <p style="color: #6b7280; margin: 10px 0 0 0;">Reset Your Password</p>
                </div>
                
                <h2 style="color: #374151; margin-bottom: 20px;">Hello <%= USER %>!</h2>
                
                <p style="color: #6b7280; line-height: 1.6; margin-bottom: 25px;">
                  We received a request to reset your password for your SerpBays account. 
                  Click the button below to create a new password:
                </p>
                
                <div style="text-align: center; margin: 30px 0;">
                  <a href="<%= URL %>" 
                     style="background: #3b82f6; color: white; padding: 12px 30px; 
                            text-decoration: none; border-radius: 6px; font-weight: bold;
                            display: inline-block;">
                    Reset My Password
                  </a>
                </div>
                
                <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                  This link will expire in 1 hour for security reasons.
                </p>
                
                <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                  If you didn't request this password reset, you can safely ignore this email.
                  Your password will remain unchanged.
                </p>
                
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
                
                <p style="color: #9ca3af; font-size: 14px; text-align: center;">
                  If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="<%= URL %>" style="color: #3b82f6;"><%= URL %></a>
                </p>
              </div>
            </div>
          `,
        },
      },
    });
    
    console.log('📧 Email templates configured successfully');
    
    await app.destroy();
    console.log('🏁 Setup completed successfully!');
    
  } catch (error) {
    console.error('❌ Error enabling email confirmation:', error);
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  enableEmailConfirmation();
}

module.exports = enableEmailConfirmation; 