#!/usr/bin/env node

/**
 * Script to properly approve a publisher website
 * Usage: node scripts/approve-website.js <website-id> [review-notes]
 */

const axios = require('axios');

async function approveWebsite(websiteId, reviewNotes = 'Approved via script') {
  try {
    console.log(`🔄 Approving website ID: ${websiteId}`);
    
    // First try the main approval endpoint
    let response;
    try {
      response = await axios.put(
        `http://localhost:1337/api/publisher-websites/${websiteId}/approve`,
        {
          reviewNotes: reviewNotes
        },
        {
          headers: {
            'Content-Type': 'application/json',
            // Note: In production, you'll need to add proper authentication headers
            // 'Authorization': 'Bearer YOUR_ADMIN_TOKEN'
          }
        }
      );
    } catch (mainError) {
      console.log('⚠️ Main approval endpoint failed, trying manual approval...');
      
      // Fallback to manual approval endpoint
      response = await axios.post(
        `http://localhost:1337/api/publisher-websites/${websiteId}/manual-approve`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );
    }

    console.log('✅ Website approved successfully!');
    console.log('Response:', response.data);
    
    return response.data;
  } catch (error) {
    console.error('❌ Failed to approve website:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const websiteId = args[0];
const reviewNotes = args[1] || 'Approved via script';

if (!websiteId) {
  console.error('❌ Please provide a website ID');
  console.log('Usage: node scripts/approve-website.js <website-id> [review-notes]');
  console.log('Example: node scripts/approve-website.js 26 "Great content and quality website"');
  process.exit(1);
}

// Run the approval
approveWebsite(websiteId, reviewNotes);
