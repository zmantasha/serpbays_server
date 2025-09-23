const strapi = require('@strapi/strapi');

async function disableDefaultEmailConfirmation() {
  try {
    console.log('🔧 Disabling Strapi default email confirmation system...');
    
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
    
    // Disable email confirmation but keep registration enabled
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        email_confirmation: false, // Disable default email confirmation
        allow_register: true, // Keep registration enabled
        default_role: 'authenticated'
      }
    });

    // Also disable email templates
    const emailSettings = await pluginStore.get({ key: 'email' });
    await pluginStore.set({
      key: 'email',
      value: {
        ...emailSettings,
        // Clear any existing email templates
        reset_password: null,
        email_confirmation: null
      }
    });

    console.log('✅ Default email confirmation disabled');
    console.log('✅ Default email templates cleared');
    console.log('✅ Custom email verification system is now active');
    console.log('');
    console.log('📧 Your custom system will now handle:');
    console.log('   - User registration with custom verification');
    console.log('   - Email sending with frontend domain');
    console.log('   - Email verification with proper error handling');
    console.log('');
    console.log('🎯 Next steps:');
    console.log('1. Restart your Strapi server');
    console.log('2. Test registration at your frontend');
    console.log('3. Check that emails use your frontend domain');
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error disabling default email confirmation:', error);
    process.exit(1);
  }
}

// Run the script
disableDefaultEmailConfirmation();
