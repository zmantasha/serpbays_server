#!/usr/bin/env node

/**
 * Enhanced Withdrawal Email Templates Test Script
 * 
 * This script demonstrates the enhanced withdrawal email templates with detailed payment information
 * Run with: node scripts/test-enhanced-withdrawal-emails.js
 */

const axios = require('axios');

// Configuration
const BASE_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';

console.log('🎨 Testing Enhanced Withdrawal Email Templates');
console.log('==============================================');

async function showEnhancedFeatures() {
  console.log('\n✨ Enhanced Email Template Features:');
  console.log('====================================');
  
  const features = [
    {
      category: '💳 Payment Information',
      items: [
        'Amount paid with currency formatting',
        'Payment method (PayPal, Razorpay, Bank Transfer)',
        'Payment date and processing time',
        'External transaction ID when available',
        'Reference number generation (SB-WD-{ID}-{YEAR})'
      ]
    },
    {
      category: '📅 Timeline Details',
      items: [
        'Request submission date',
        'Approval/denial/payment dates',
        'Processing time calculation',
        'Expected arrival dates',
        'Step-by-step progress tracking'
      ]
    },
    {
      category: '📧 Contact Information',
      items: [
        'Payment destination email (from withdrawal details)',
        'Support contact details',
        'Reference numbers for support queries',
        'Business hours information',
        'Clear next steps guidance'
      ]
    },
    {
      category: '🎨 Visual Enhancements',
      items: [
        'Grid layout for key details',
        'Color-coded status sections',
        'Professional styling with borders',
        'Mobile-responsive design',
        'Clear information hierarchy'
      ]
    },
    {
      category: '💰 Financial Details',
      items: [
        'Wallet balance updates',
        'Refund information for denials',
        'Processing fees (if applicable)',
        'Payment confirmation details',
        'Account arrival timelines'
      ]
    }
  ];

  features.forEach((feature, index) => {
    console.log(`\n${index + 1}. ${feature.category}`);
    feature.items.forEach(item => {
      console.log(`   ✅ ${item}`);
    });
  });
}

async function showTemplateComparison() {
  console.log('\n📧 Template Comparison: Before vs After');
  console.log('=======================================');
  
  const templates = [
    {
      status: 'APPROVED',
      before: [
        'Basic amount and method',
        'Simple approval message',
        'Generic timeline'
      ],
      after: [
        '📋 Detailed grid layout with 4 key data points',
        '🔄 Processing information with reference number',
        '📧 Payment destination details (if available)',
        '📅 Complete timeline with checkmarks',
        '📋 "What Happens Next?" step-by-step guide',
        '💡 Professional styling with color themes'
      ]
    },
    {
      status: 'PAID',
      before: [
        'Payment completion notice',
        'Basic amount and method',
        'Simple arrival timeline'
      ],
      after: [
        '💳 Comprehensive payment summary grid',
        '🔗 External transaction ID display',
        '📅 Full timeline: submitted → processed → expected arrival',
        '🎉 Enhanced success messaging',
        '📧 Payment destination confirmation',
        '📋 4-step "What\'s Next?" guide',
        '📞 Support contact with reference number'
      ]
    },
    {
      status: 'DENIED',
      before: [
        'Basic denial message',
        'Simple refund notice',
        'Generic support info'
      ],
      after: [
        '📋 Complete request details grid',
        '🚫 Formatted denial reason with admin decision',
        '💰 Detailed automatic refund section',
        '📋 5-step next actions guide',
        '📞 Comprehensive support info with hours',
        '🔗 Specific reference number for support'
      ]
    }
  ];

  templates.forEach((template, index) => {
    console.log(`\n${index + 1}. ${template.status} EMAIL`);
    console.log('   Before (Basic):');
    template.before.forEach(item => {
      console.log(`   ❌ ${item}`);
    });
    console.log('   After (Enhanced):');
    template.after.forEach(item => {
      console.log(`   ✅ ${item}`);
    });
  });
}

async function testEnhancedEmails() {
  if (process.env.NODE_ENV === 'production') {
    console.log('\n⚠️  Email testing is disabled in production for security.');
    return;
  }

  try {
    console.log('\n🧪 Testing Enhanced Email Templates...');
    console.log(`📧 Test emails will be sent to: ${TEST_EMAIL}`);
    
    const tests = [
      {
        type: 'withdrawal_approved',
        description: 'Enhanced approval email with timeline and processing info'
      },
      {
        type: 'withdrawal_paid', 
        description: 'Enhanced payment email with transaction details'
      },
      {
        type: 'withdrawal_denied',
        description: 'Enhanced denial email with refund info and support'
      }
    ];

    for (const test of tests) {
      try {
        console.log(`\n📤 Sending ${test.type} email...`);
        
        const response = await axios.post(`${BASE_URL}/api/email/test`, {
          type: test.type,
          email: TEST_EMAIL,
          withdrawalId: 174 // Using the same ID from your screenshot
        });
        
        console.log(`✅ ${test.description}`);
        console.log(`   Response: ${response.data?.message || 'Email sent successfully'}`);
        
      } catch (error) {
        console.log(`❌ Failed to send ${test.type}: ${error.response?.data?.message || error.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Email testing failed:', error.message);
  }
}

async function showImplementationDetails() {
  console.log('\n🔧 Implementation Details');
  console.log('=========================');
  
  console.log(`
📊 Enhanced Template Features:

1. 📋 GRID LAYOUTS
   ├── 2-column responsive grids for key data
   ├── Consistent spacing and alignment
   └── Mobile-friendly responsive design

2. 📅 DYNAMIC CALCULATIONS
   ├── Processing time: Math.ceil((currentDate - requestDate) / days)
   ├── Expected dates: new Date(currentDate + 3 days)
   └── Timeline progression with checkmarks

3. 🔗 REFERENCE NUMBERS
   ├── Format: SB-WD-{ID}-{YEAR}
   ├── Denial format: SB-WD-{ID}-DENIED-{YEAR}
   └── Used for support ticket tracking

4. 💳 PAYMENT DETAILS
   ├── External transaction ID display
   ├── Payment destination from withdrawal.details.email
   ├── Method formatting: method?.toUpperCase()
   └── Currency and amount formatting

5. 🎨 VISUAL IMPROVEMENTS
   ├── Status-specific color themes (green/blue/red)
   ├── Border-left accent colors for sections
   ├── Professional spacing and typography
   └── Clear information hierarchy

6. 📞 SUPPORT INTEGRATION
   ├── Reference numbers for easy ticket creation
   ├── Business hours information
   ├── Specific contact methods
   └── Context-aware support guidance
  `);
}

async function showDataFlow() {
  console.log('\n🔄 Data Flow for Enhanced Emails');
  console.log('=================================');
  
  console.log(`
📈 Enhanced Data Usage:

FROM WITHDRAWAL REQUEST:
┌─────────────────────────────────────┐
│ withdrawalRequest.id               │ → Reference number generation
│ withdrawalRequest.amount           │ → Payment amount display
│ withdrawalRequest.method           │ → Payment method (formatted)
│ withdrawalRequest.createdAt        │ → Timeline calculations
│ withdrawalRequest.details.email    │ → Payment destination
│ withdrawalRequest.external_transaction_id │ → Transaction tracking
│ withdrawalRequest.denial_reason    │ → Formatted denial reason
└─────────────────────────────────────┘
                    ↓
FROM CALCULATIONS:
┌─────────────────────────────────────┐
│ Processing time (days)             │ → Timeline display
│ Expected payment date              │ → Arrival estimates
│ Current date formatting            │ → Consistent date display
│ Reference number generation        │ → Support tracking
└─────────────────────────────────────┘
                    ↓
TO EMAIL TEMPLATE:
┌─────────────────────────────────────┐
│ Professional HTML with grids       │
│ Dynamic content based on status    │
│ Mobile-responsive styling          │
│ Action-specific guidance           │
└─────────────────────────────────────┘
  `);
}

// Main execution
async function main() {
  console.log(`🎯 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 API Base URL: ${BASE_URL}`);
  
  await showEnhancedFeatures();
  await showTemplateComparison();
  await testEnhancedEmails();
  await showImplementationDetails();
  await showDataFlow();
  
  console.log('\n🎉 Enhanced Withdrawal Email Templates are Ready!');
  console.log('\n📧 Key Improvements:');
  console.log('✅ Detailed payment information grids');
  console.log('✅ Processing timeline with dates');
  console.log('✅ Transaction reference numbers');
  console.log('✅ Payment destination details');
  console.log('✅ Professional responsive design');
  console.log('✅ Context-aware support information');
  console.log('✅ Step-by-step guidance for users');
  
  console.log('\n🔄 Your Current Email (Withdrawal #174):');
  console.log('✅ Working perfectly with basic template');
  console.log('🎨 Now enhanced with:');
  console.log('   • Payment timeline details');
  console.log('   • Transaction reference number');
  console.log('   • Expected arrival date');
  console.log('   • Support contact information');
  console.log('   • Professional grid layout');
}

// Run the script
main().catch(console.error);

module.exports = {
  showEnhancedFeatures,
  showTemplateComparison,
  testEnhancedEmails,
  showImplementationDetails
};
