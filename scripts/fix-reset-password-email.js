const strapi = require('@strapi/strapi');

async function fixResetPasswordEmail() {
  let app;
  
  try {
    console.log('🔧 Fixing reset password email configuration...');
    
    // Initialize Strapi properly
    app = await strapi.createStrapi({}).load();
    
    // Get the plugin store
    const pluginStore = app.store({
      environment: '',
      type: 'plugin',
      name: 'users-permissions',
    });

    // Get current advanced settings
    const advancedSettings = await pluginStore.get({ key: 'advanced' });
    console.log('📋 Current advanced settings:', JSON.stringify(advancedSettings, null, 2));
    
    // Update advanced settings with reset password URL
    const updatedAdvancedSettings = {
      ...advancedSettings,
      email_reset_password: `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password`,
    };
    
    await pluginStore.set({
      key: 'advanced',
      value: updatedAdvancedSettings
    });

    console.log('✅ Reset password URL configured:', `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password`);
    
    // Get current email settings
    const emailSettings = await pluginStore.get({ key: 'email' });
    console.log('📧 Current email settings exist:', !!emailSettings);
    
    console.log('✅ Reset password email configuration updated successfully!');
    
  } catch (error) {
    console.error('❌ Error fixing reset password email:', error);
    throw error;
  } finally {
    if (app) {
      await app.destroy();
    }
  }
}

// Run the fix
if (require.main === module) {
  fixResetPasswordEmail()
    .then(() => {
      console.log('Fix completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fix failed:', error);
      process.exit(1);
    });
}

module.exports = fixResetPasswordEmail; 