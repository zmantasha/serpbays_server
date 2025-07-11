const strapi = require('@strapi/strapi');

async function setupEmailVerification() {
  try {
    // Initialize Strapi
    await strapi.load();
    
    // Get the plugin store
    const pluginStore = strapi.store({
      environment: '',
      type: 'plugin',
      name: 'users-permissions',
    });

    // Enable email confirmation
    const advancedSettings = await pluginStore.get({ key: 'advanced' });
    
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        email_confirmation: true,
        email_confirmation_redirection: `${process.env.CLIENT_URL || 'http://localhost:3000'}/email-verification?verified=true`,
        email_reset_password: `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password`,
        allow_register: true,
        default_role: 'authenticated'
      }
    });

    // Get email settings
    const emailSettings = await pluginStore.get({ key: 'email' });

    // Set up email templates
    const defaultEmailSettings = {
      reset_password: {
        display: 'Email.template.reset_password',
        icon: 'sync',
        options: {
          from: {
            name: 'SerpBays',
            email: process.env.EMAIL_FROM || 'noreply@serpbays.com'
          },
          response_email: process.env.EMAIL_REPLY_TO || 'support@serpbays.com',
          object: 'Reset Your SerpBays Password',
          message: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
            <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #3b82f6; margin: 0;">SerpBays</h1>
                <p style="color: #6b7280; margin: 10px 0 0 0;">Reset Your Password</p>
              </div>
              
              <h2 style="color: #374151; margin-bottom: 20px;">Hello <%= USER.username || USER.email %>!</h2>
              
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
          </div>`
        }
      },
      email_confirmation: {
        display: 'Email.template.email_confirmation',
        icon: 'check-square',
        options: {
          from: {
            name: 'SerpBays',
            email: process.env.EMAIL_FROM || 'noreply@serpbays.com'
          },
          response_email: process.env.EMAIL_REPLY_TO || 'support@serpbays.com',
          object: 'Welcome to SerpBays - Please Verify Your Email',
          message: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
            <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #3b82f6; margin: 0;">SerpBays</h1>
                <p style="color: #6b7280; margin: 10px 0 0 0;">Email Verification</p>
              </div>
              
              <h2 style="color: #374151; margin-bottom: 20px;">Welcome <%= USER.username || USER.email %>!</h2>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 25px;">
                Thank you for joining SerpBays! To complete your registration and secure your account, 
                please verify your email address by clicking the button below:
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="<%= URL %>" 
                   style="background: #10b981; color: white; padding: 12px 30px; 
                          text-decoration: none; border-radius: 6px; font-weight: bold;
                          display: inline-block;">
                  Verify My Email
                </a>
              </div>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                Once verified, you'll be able to access all SerpBays features including our marketplace,
                content creation tools, and more.
              </p>
              
              <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
                If you didn't create this account, you can safely ignore this email.
              </p>
              
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
              
              <p style="color: #9ca3af; font-size: 14px; text-align: center;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="<%= URL %>" style="color: #3b82f6;"><%= URL %></a>
              </p>
            </div>
          </div>`
        }
      }
    };

    await pluginStore.set({
      key: 'email',
      value: {
        ...emailSettings,
        ...defaultEmailSettings
      }
    });

    console.log('✅ Email verification has been enabled successfully!');
    console.log('✅ Email templates have been configured with SerpBays branding!');
    console.log('✅ Settings updated:');
    console.log('   - Email confirmation: enabled');
    console.log(`   - Confirmation redirect: ${process.env.CLIENT_URL || 'http://localhost:3000'}/email-verification`);
    console.log('   - Registration: enabled');
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error setting up email verification:', error);
    process.exit(1);
  }
}

// Run the setup
setupEmailVerification(); 