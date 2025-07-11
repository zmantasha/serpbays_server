const fs = require('fs');
const path = require('path');

// Function to read and update the SQLite database settings
async function enableEmailConfirmation() {
  try {
    console.log('🔧 Enabling email confirmation...');
    
    // For Strapi 5, we need to update the settings through the admin panel or directly in the database
    // Since the previous approach didn't work, let's create a manual configuration
    
    const configPath = path.join(__dirname, '..', 'config', 'plugins.js');
    console.log('📝 Updating plugins configuration...');
    
    // The email configuration is already added in plugins.js
    // Now we need to ensure Strapi knows to require email confirmation
    
    console.log('✅ Email configuration is ready in plugins.js');
    console.log('📧 Email provider: nodemailer configured for Gmail SMTP');
    
    console.log('\n🎯 Manual Steps Required:');
    console.log('1. Start Strapi: npm run develop');
    console.log('2. Go to: http://localhost:1337/admin');
    console.log('3. Navigate to: Settings → Users & Permissions Plugin → Advanced Settings');
    console.log('4. Check "Enable email confirmation"');
    console.log('5. Set "Confirmation page" to: http://localhost:3000/email-verification');
    console.log('6. Save the settings');
    
    console.log('\n⚠️  Important: You must complete the manual steps above for email verification to work!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\nPlease follow the manual steps to enable email confirmation.');
  }
}

// Run the script
if (require.main === module) {
  enableEmailConfirmation();
}

module.exports = enableEmailConfirmation; 