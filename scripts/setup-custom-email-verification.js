const strapi = require('@strapi/strapi');

async function setupCustomEmailVerification() {
  try {
    console.log('🔧 Setting up custom email verification system...');
    
    // Initialize Strapi
    await strapi.load();
    
    // Get the plugin store
    const pluginStore = strapi.store({
      environment: '',
      type: 'plugin',
      name: 'users-permissions',
    });

    // Disable default email confirmation
    const advancedSettings = await pluginStore.get({ key: 'advanced' });
    
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        email_confirmation: false, // Disable default email confirmation
        allow_register: true,
        default_role: 'authenticated'
      }
    });

    console.log('✅ Default email confirmation disabled');
    console.log('✅ Custom email verification system ready');
    console.log('');
    console.log('📧 Custom verification endpoints:');
    console.log('   - POST /api/auth/local/register (custom registration)');
    console.log('   - POST /api/auth/send-email-confirmation (resend email)');
    console.log('   - GET /api/auth/verify-email (verify with token)');
    console.log('');
    console.log('🎯 Next steps:');
    console.log('1. Update your client registration to use /api/auth/local/register');
    console.log('2. Test the custom verification flow');
    console.log('3. Verify emails point to your frontend domain');
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error setting up custom email verification:', error);
    process.exit(1);
  }
}

// Run the setup
setupCustomEmailVerification();
