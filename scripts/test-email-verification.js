#!/usr/bin/env node

const strapi = require('@strapi/strapi');

async function testEmailVerification() {
  try {
    console.log('🧪 Testing email verification flow...');
    
    // Initialize Strapi
    await strapi.load();
    
    // Test 1: Test with invalid token
    console.log('\n1. Testing invalid token handling...');
    const invalidToken = 'invalid-token-12345';
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    
    try {
      // Simulate the email confirmation request
      const response = await fetch(`${process.env.STRAPI_URL || 'http://localhost:1337'}/api/auth/email-confirmation?confirmation=${invalidToken}`);
      
      if (response.redirected) {
        console.log('✅ Invalid token correctly redirected to:', response.url);
        if (response.url.includes('error=invalid_token')) {
          console.log('✅ Error parameter correctly set to invalid_token');
        } else {
          console.log('❌ Error parameter not set correctly');
        }
      } else {
        console.log('❌ Invalid token not redirected properly');
      }
    } catch (error) {
      console.log('❌ Error testing invalid token:', error.message);
    }
    
    // Test 2: Test with expired token (if we can simulate one)
    console.log('\n2. Testing expired token handling...');
    const expiredToken = 'expired-token-12345';
    
    try {
      const response = await fetch(`${process.env.STRAPI_URL || 'http://localhost:1337'}/api/auth/email-confirmation?confirmation=${expiredToken}`);
      
      if (response.redirected) {
        console.log('✅ Expired token correctly redirected to:', response.url);
        if (response.url.includes('error=expired_token')) {
          console.log('✅ Error parameter correctly set to expired_token');
        } else {
          console.log('❌ Error parameter not set correctly for expired token');
        }
      } else {
        console.log('❌ Expired token not redirected properly');
      }
    } catch (error) {
      console.log('❌ Error testing expired token:', error.message);
    }
    
    console.log('\n✅ Email verification flow test completed!');
    console.log('\n📝 Next steps:');
    console.log('1. Start your Strapi server: npm run develop');
    console.log('2. Start your client app: npm run dev');
    console.log('3. Test with a real invalid token by visiting:');
    console.log(`   ${clientUrl}/email-verification?error=invalid_token`);
    console.log(`   ${clientUrl}/email-verification?error=expired_token`);
    console.log(`   ${clientUrl}/email-verification?error=already_confirmed`);
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error testing email verification:', error);
    process.exit(1);
  }
}

// Run the test
testEmailVerification();
