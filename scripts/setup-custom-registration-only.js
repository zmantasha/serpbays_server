const strapi = require('@strapi/strapi');

async function setupCustomRegistrationOnly() {
  try {
    console.log('🔧 Setting up custom registration system (bypassing users-permissions)...');
    
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
    
    // Disable users-permissions registration completely
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        allow_register: false, // Disable users-permissions registration
        email_confirmation: false, // Disable email confirmation
        default_role: 'authenticated'
      }
    });

    console.log('✅ Users-permissions registration disabled');
    console.log('✅ Email confirmation disabled');
    console.log('✅ Custom registration system will handle everything');
    console.log('');
    console.log('📧 How it works:');
    console.log('   1. Users-permissions registration is disabled');
    console.log('   2. Custom registration endpoint handles registration');
    console.log('   3. Custom email service sends verification emails');
    console.log('   4. Users verify via frontend domain links');
    console.log('');
    console.log('🎯 Next steps:');
    console.log('1. Restart your Strapi server');
    console.log('2. Test registration at your frontend');
    console.log('3. Check that emails use your frontend domain');
    console.log('4. Verify the registration flow works without errors');
    console.log('');
    console.log('📝 Note: Your frontend should use the custom registration endpoint:');
    console.log('   POST /api/auth/local/register');
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error setting up custom registration:', error);
    process.exit(1);
  }
}

// Run the setup
setupCustomRegistrationOnly();
