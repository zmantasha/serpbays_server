#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Simple script to enable email confirmation
console.log('🔧 Enabling email confirmation...');

// Update package.json to add setup script
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Add scripts for email setup
packageJson.scripts = {
  ...packageJson.scripts,
  'email:setup': 'node scripts/enable-email-confirmation.js'
};

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log('✅ Email setup script added to package.json');
console.log('');
console.log('🚀 Next steps:');
console.log('1. Create .env file with your Gmail credentials');
console.log('2. Enable 2FA on Gmail and create App Password');
console.log('3. Start the server with: npm run develop');
console.log('4. Go to Strapi Admin > Settings > Users & Permissions > Advanced Settings');
console.log('5. Enable "Enable email confirmation"');
console.log('');
console.log('📧 For detailed instructions, see EMAIL_SETUP_GUIDE.md'); 