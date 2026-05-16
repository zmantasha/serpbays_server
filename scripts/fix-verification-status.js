#!/usr/bin/env node

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function fixVerificationStatus() {
  return new Promise((resolve, reject) => {
    console.log('Starting verification status fix...');
    
    // Connect to the SQLite database
    const dbPath = path.join(__dirname, '..', '.tmp', 'data.db');
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error connecting to database:', err);
        reject(err);
        return;
      }
      console.log('Connected to SQLite database');
    });
    
    // First, let's see what websites need fixing
    db.all(`
      SELECT id, url, verification_method, gsc_verified, gsc_verified_at 
      FROM publisher_websites 
      WHERE verification_method = 'google-search-console' 
      AND (gsc_verified IS NULL OR gsc_verified = 0)
    `, (err, rows) => {
      if (err) {
        console.error('Error querying database:', err);
        db.close();
        reject(err);
        return;
      }
      
      console.log(`Found ${rows.length} websites to fix:`);
      rows.forEach(row => {
        console.log(`- ID: ${row.id}, URL: ${row.url}, GSC Verified: ${row.gsc_verified}`);
      });
      
      if (rows.length === 0) {
        console.log('No websites need fixing');
        db.close();
        resolve();
        return;
      }
      
      // Update the websites
      const updateQuery = `
        UPDATE publisher_websites 
        SET 
          gsc_verified = 1,
          gsc_verified_at = datetime('now')
        WHERE 
          verification_method = 'google-search-console' 
          AND (gsc_verified IS NULL OR gsc_verified = 0)
      `;
      
      db.run(updateQuery, function(err) {
        if (err) {
          console.error('Error updating database:', err);
          db.close();
          reject(err);
          return;
        }
        
        console.log(`✅ Successfully updated ${this.changes} websites`);
        
        // Verify the changes
        db.all(`
          SELECT id, url, verification_method, gsc_verified, gsc_verified_at 
          FROM publisher_websites 
          WHERE verification_method = 'google-search-console'
        `, (err, updatedRows) => {
          if (err) {
            console.error('Error verifying changes:', err);
          } else {
            console.log('Updated websites:');
            updatedRows.forEach(row => {
              console.log(`- ID: ${row.id}, URL: ${row.url}, GSC Verified: ${row.gsc_verified}, Verified At: ${row.gsc_verified_at}`);
            });
          }
          
          db.close((err) => {
            if (err) {
              console.error('Error closing database:', err);
              reject(err);
            } else {
              console.log('Database connection closed');
              console.log('Verification status fix completed!');
              resolve();
            }
          });
        });
      });
    });
  });
}

// Run the fix
fixVerificationStatus().then(() => {
  console.log('Script completed successfully');
  process.exit(0);
}).catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
