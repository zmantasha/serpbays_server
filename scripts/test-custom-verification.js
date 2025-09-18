#!/usr/bin/env node

const strapi = require('@strapi/strapi');

async function testCustomVerification() {
  try {
    console.log('🧪 Testing custom email verification system...');
    
    // Initialize Strapi
    await strapi.load();
    
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    const serverUrl = process.env.STRAPI_URL || 'http://localhost:1337';
    
    console.log('\n1. Testing custom registration...');
    
    // Test registration
    try {
      const registerResponse = await fetch(`${serverUrl}/api/auth/local/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser123',
          email: 'test@example.com',
          password: 'password123',
          firstName: 'Test',
          lastName: 'User'
        })
      });
      
      if (registerResponse.ok) {
        const registerData = await registerResponse.json();
        console.log('✅ Registration successful:', registerData.message);
      } else {
        const errorData = await registerResponse.json();
        console.log('❌ Registration failed:', errorData.message);
      }
    } catch (error) {
      console.log('❌ Registration error:', error.message);
    }
    
    console.log('\n2. Testing resend verification email...');
    
    // Test resend email
    try {
      const resendResponse = await fetch(`${serverUrl}/api/auth/send-email-confirmation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'test@example.com'
        })
      });
      
      if (resendResponse.ok) {
        const resendData = await resendResponse.json();
        console.log('✅ Resend email successful:', resendData.message);
      } else {
        const errorData = await resendResponse.json();
        console.log('❌ Resend email failed:', errorData.message);
      }
    } catch (error) {
      console.log('❌ Resend email error:', error.message);
    }
    
    console.log('\n3. Testing verification with invalid token...');
    
    // Test verification with invalid token
    try {
      const verifyResponse = await fetch(`${serverUrl}/api/api/auth/verify-email?confirmation=invalid-token&email=test@example.com`);
      
      if (verifyResponse.redirected) {
        console.log('✅ Invalid token correctly redirected to:', verifyResponse.url);
        if (verifyResponse.url.includes('error=invalid_token')) {
          console.log('✅ Error parameter correctly set to invalid_token');
        } else {
          console.log('❌ Error parameter not set correctly');
        }
      } else {
        console.log('❌ Invalid token not redirected properly');
      }
    } catch (error) {
      console.log('❌ Verification error:', error.message);
    }
    
    console.log('\n✅ Custom verification system test completed!');
    console.log('\n📝 Next steps:');
    console.log('1. Start your Strapi server: npm run develop');
    console.log('2. Start your client app: npm run dev');
    console.log('3. Test registration at: http://localhost:3000/register');
    console.log('4. Check your email for verification link');
    console.log('5. Test verification at: http://localhost:3000/email-verification');
    
    await strapi.destroy();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error testing custom verification:', error);
    process.exit(1);
  }
}

// Run the test
testCustomVerification();
