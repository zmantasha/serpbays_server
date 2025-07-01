const strapi = require('@strapi/strapi');

async function disableEmailConfirmation() {
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
    
    // Disable email confirmation for immediate registration
    await pluginStore.set({
      key: 'advanced',
      value: {
        ...advancedSettings,
        email_confirmation: false,
        allow_register: true,
      },
    });
    
    console.log('✅ Email confirmation disabled - users can register immediately');
    console.log('🔓 Registration enabled for all users');
    
    await app.destroy();
    console.log('🏁 Configuration updated successfully!');
    
  } catch (error) {
    console.error('❌ Error disabling email confirmation:', error);
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  disableEmailConfirmation();
}

module.exports = disableEmailConfirmation; 