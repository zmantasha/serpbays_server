const strapi = require('@strapi/strapi');

async function setupCustomVerificationWithRegistration() {
  try {
    console.log('🔧 Setting up custom email verification with registration enabled...');
    
    // Initialize Strapi
    await strapi.load();
    
    // Get the plugin store
    const pluginStore = strapi.store({
      environment: '',
      type: 'plugin',
      name: 'users-permissions',
    });

    // Get current advanced settings
    const advancedSettings = await pluginStore.get({ key: 'advanced' });
    
    // Configure settings: disable email confirmation but keep registration enabled
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        email_confirmation: false, // Disable default email confirmation
        allow_register: true, // Keep registration enabled
        default_role: 'authenticated'
      }
    });

    console.log('✅ Email confirmation disabled');
    console.log('✅ Registration kept enabled');
    console.log('✅ Custom verification system will handle email sending');
    console.log('');
    console.log('📧 How it works:');
    console.log('   1. Users can register normally');
    console.log('   2. Custom controller creates unconfirmed users');
    console.log('   3. Custom email service sends verification emails');
    console.log('   4. Users verify via frontend domain links');
    console.log('');
    console.log('🎯 Next steps:');
    console.log('1. Restart your Strapi server');
    console.log('2. Test registration at your frontend');
    console.log('3. Check that emails use your frontend domain');
    console.log('4. Verify the registration flow works without errors');
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error setting up custom verification:', error);
    process.exit(1);
  }
}

// Run the setup
setupCustomVerificationWithRegistration();
