import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Download } from '@strapi/icons';
import { exportMarketplaceCsv } from './exportCsv.js';

// Required fields for CSV validation
const REQUIRED_FIELDS = [
  'url', 
  'price', 
  'publisher_name', 
  'publisher_price', 
  'publisher_email', 
  'backlink_type', 
  'category', 
  'backlink_validity', 
  'min_word_count', 
];

const MISSING_FIELDS = [
  'url', 
  'price', 
  'link_insertion_price',
  'publisher_name', 
  'publisher_price', 
  'publisher_email', 
  'publisher_forbidden_gp_price', 
  'publisher_forbidden_li_price', 
  'publisher_link_insertion_price', 
  'backlink_type', 
  'category', 
  'other_category', 
  'guidelines',
  'dofollow_link',
  'sample_post', 
  'backlink_validity', 
  'ahrefs_dr', 
  'ahrefs_traffic', 
  'ahrefs_rank', 
  'moz_da', 
  'fast_placement_status', 
  'sample_post', 
  'tat', 
  'min_word_count', 
  'forbidden_gp_price', 
  'forbidden_li_price'
];

export default {
  bootstrap() {},
  
  async registerTrads() {
    return [];
  },
  
  register({ getPlugin }) {
    const plugin = getPlugin('content-manager');
    
    // Import Modal Component
    const ImportModal = ({ setIsVisible }) => {
      const [file, setFile] = useState(null);
      const [isUploading, setIsUploading] = useState(false);
      const [error, setError] = useState(null);
      const [duplicates, setDuplicates] = useState(null);
      const [createdCount, setCreatedCount] = useState(0);
      const [selectedDuplicates, setSelectedDuplicates] = useState([]);

      const validateCSVHeaders = async (file) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            try {
              // Get first line and parse headers
              const firstLine = event.target.result.toString().split('\n')[0];
              const headers = firstLine.split(',').map(h => h.trim().toLowerCase());
              
              // Check for missing required fields
              const missingFields = MISSING_FIELDS.filter(field => !headers.includes(field));
              const requiredFields = REQUIRED_FIELDS.filter(field => !headers.includes(field));
              
              if (missingFields.length > 0) {
                reject(`Missing required fields: ${missingFields.join(', ')}`);
              }else if(requiredFields.length>0){
                reject(`Required fields are: ${REQUIRED_FIELDS.join(', ')}`);
              } else {
                resolve(true);
              }
            } catch (error) {
              reject('Error reading CSV headers');
            }
          };
          reader.onerror = () => reject('Error reading file');
          reader.readAsText(file);
        });
      };

      const handleFileChange = async (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile && selectedFile.type === 'text/csv') {
          try {
            await validateCSVHeaders(selectedFile);
            setFile(selectedFile);
            setError(null);
          } catch (error) {
            setError(error);
            setFile(null);
          }
        } else {
          setError('Please select a valid CSV file');
          setFile(null);
        }
      };

      const handleDuplicateToggle = (url) => {
        setSelectedDuplicates(prev => {
          if (prev.includes(url)) {
            return prev.filter(item => item !== url);
          } else {
            return [...prev, url];
          }
        });
      };

      const handleDownloadDuplicates = () => {
        if (!duplicates || !duplicates.duplicates.length) return;
        
        // Create CSV content with more columns
        const headers = [
          'URL', 
          'Current Price', 
          'New Price', 
          'Current Publisher Name',
          'New Publisher Name',
          'Current Publisher Email',
          'New Publisher Email',
          'Current Publisher Price',
          'New Publisher Price'
        ];
        
        const rows = duplicates.duplicates.map(dup => [
          dup.url,
          dup.existingData.price,
          dup.newData.price,
          dup.existingData.publisher_name || '',
          dup.newData.publisher_name || '',
          dup.existingData.publisher_email || '',
          dup.newData.publisher_email || '',
          dup.existingData.publisher_price || '',
          dup.newData.publisher_price || ''
        ]);
        
        const csvContent = [
          headers.join(','),
          ...rows.map(row => row.join(','))
        ].join('\n');
        
        // Create download link
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', 'duplicate_urls.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      };

      const handleConfirmDuplicates = async () => {
        if (selectedDuplicates.length === 0) {
          setError('No duplicates selected for update');
          return;
        }

        setIsUploading(true);
        setError(null);

        try {
          // Get auth token from localStorage, sessionStorage, or cookies
          let auth = null;
          
          try {
            auth = JSON.parse(localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken'));
          } catch (e) {
            console.log('Error parsing token from storage:', e);
          }
          
          // If not found in storage, try to get from cookies
          if (!auth) {
            const cookies = document.cookie.split(';');
            for (let i = 0; i < cookies.length; i++) {
              const cookie = cookies[i].trim();
              if (cookie.startsWith('jwtToken')) {
                const equalPos = cookie.indexOf('=');
                if (equalPos !== -1) {
                  auth = cookie.substring(equalPos + 1);
                  break;
                }
              }
            }
          }
          
          if (!auth) {
            throw new Error('Authentication token not found in storage or cookies');
          }

          // Send confirmation request
          const response = await axios.post('/api/upload-csv', {
            fileId: duplicates.fileId,
            confirmDuplicates: selectedDuplicates
          }, {
            headers: {
              'Authorization': `Bearer ${auth}`
            },
            withCredentials: true, // Include cookies in the request
          });

          if (response.data) {
            if (response.data.errors && response.data.errors.length > 0) {
              setError(`Import completed with errors:\n${response.data.errors.join('\n')}`);
            } else {
              // Refresh the list view
              window.location.reload();
            }
          }
        } catch (err) {
          console.error('Duplicate confirmation error:', err);
          const errorMessage = err.response?.data?.error?.message || err.message || 'Error updating duplicates';
          setError(errorMessage);
        } finally {
          setIsUploading(false);
          setDuplicates(null);
        }
      };

      const handleUpload = async () => {
        if (!file) {
          setError('Please select a file first');
          return;
        }

        setIsUploading(true);
        setError(null);

        const formData = new FormData();
        formData.append('files', file);

        try {
          // Get auth token from localStorage, sessionStorage, or cookies
          let auth = null;
          
          try {
            auth = JSON.parse(localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken'));
            console.log('Token from storage:', auth ? 'Found' : 'Not found');
          } catch (e) {
            console.log('Error parsing token from storage:', e);
          }
          
          // If not found in storage, try to get from cookies
          if (!auth) {
            console.log('Searching for token in cookies...');
            const cookies = document.cookie.split(';');
            console.log('All cookies:', cookies);
            
            // Try direct access to the cookie
            const jwtTokenCookie = document.cookie
              .split('; ')
              .find(row => row.startsWith('jwtToken'));
              
            if (jwtTokenCookie) {
              console.log('Found jwtToken cookie:', jwtTokenCookie);
              // Just use the entire cookie value
              auth = jwtTokenCookie.split('=')[1];
              console.log('Extracted auth token:', auth ? 'Found' : 'Not found');
            } else {
              console.log('jwtToken cookie not found');
              
              // Try finding the token in any cookie for safety
              for (let i = 0; i < cookies.length; i++) {
                const cookie = cookies[i].trim();
                console.log(`Checking cookie: ${cookie}`);
                
                if (cookie.startsWith('jwtToken')) {
                  console.log('Found cookie starting with jwtToken:', cookie);
                  
                  // Try both methods of extraction
                  const parts = cookie.split('=');
                  if (parts.length > 1) {
                    auth = parts[1];
                    console.log('Extracted token using split:', auth ? 'Found' : 'Not found');
                  } else {
                    // If no equals sign, take everything after "jwtToken"
                    auth = cookie.substring('jwtToken'.length).trim();
                    console.log('Extracted token using substring:', auth ? 'Found' : 'Not found');
                  }
                  
                  break;
                }
              }
            }
          }
          
          // Last resort: try parsing the cookie string manually
          if (!auth) {
            console.log('Trying alternative cookie parsing');
            const cookieString = document.cookie;
            console.log('Full cookie string:', cookieString);
            
            // Check if jwtToken is anywhere in the cookie string
            if (cookieString.includes('jwtToken')) {
              const startIndex = cookieString.indexOf('jwtToken') + 'jwtToken'.length;
              let endIndex = cookieString.indexOf(';', startIndex);
              if (endIndex === -1) endIndex = cookieString.length;
              
              // Extract everything after jwtToken
              const tokenPart = cookieString.substring(startIndex, endIndex).trim();
              
              // Check if it starts with =
              if (tokenPart.startsWith('=')) {
                auth = tokenPart.substring(1);
              } else {
                auth = tokenPart;
              }
              
              console.log('Extracted using manual parsing:', auth ? 'Found' : 'Not found');
            }
          }
          
          if (!auth) {
            console.log('Failed to find token in cookies. Raw cookie string:', document.cookie);
            throw new Error('Authentication token not found in storage or cookies');
          }

          console.log('Successfully found authentication token');

          // First upload the file
          const uploadResponse = await axios.post('/upload', formData, {
            headers: {
              'Content-Type': 'multipart/form-data',
              'Authorization': `Bearer ${auth}`
            },
            withCredentials: true, // Include cookies in the request
          });

          if (uploadResponse.data) {
            // Now process the uploaded file
            const response = await axios.post('/api/upload-csv', {
              fileId: uploadResponse.data[0].id
            }, {
              headers: {
                'Authorization': `Bearer ${auth}`
              },
              withCredentials: true, // Include cookies in the request
            });

            if (response.data) {
              if (response.data.needsConfirmation) {
                // Store duplicates for confirmation
                setDuplicates({
                  ...response.data,
                  fileId: uploadResponse.data[0].id
                });
                setCreatedCount(response.data.createdCount || 0);
              } else if (response.data.errors && response.data.errors.length > 0) {
                setError(`Import completed with errors:\n${response.data.errors.join('\n')}`);
              } else {
                // Refresh the list view
                window.location.reload();
              }
            }
          }
        } catch (err) {
          console.error('Upload error:', err);
          const errorMessage = err.response?.data?.error?.message || err.message || 'Error uploading file';
          console.log('File being uploaded:', file);
          setError(errorMessage);
        } finally {
          setIsUploading(false);
        }
      };

      // Improved modern styling
      const modalOverlayStyle = {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        zIndex: 999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      };

      const modalStyle = {
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.15)',
        width: '600px',
        maxWidth: '90vw',
        maxHeight: '85vh',
        overflowY: 'auto',
        padding: '28px',
        position: 'relative',
        animation: 'modalFadeIn 0.3s ease-out',
        border: '1px solid #eaeaea'
      };

      const modalHeaderStyle = {
        marginTop: 0,
        marginBottom: '24px',
        fontSize: '24px',
        fontWeight: '600',
        color: '#32324d',
        borderBottom: '1px solid #f5f5f5',
        paddingBottom: '16px'
      };

      const buttonStyle = {
        padding: '10px 16px',
        borderRadius: '4px',
        fontSize: '14px',
        fontWeight: '500',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      };

      const primaryButtonStyle = {
        ...buttonStyle,
        backgroundColor: '#4945FF',
        color: 'white',
        border: 'none',
        boxShadow: '0 2px 6px rgba(73, 69, 255, 0.25)',
        '&:hover': {
          backgroundColor: '#3732e5',
          boxShadow: '0 4px 12px rgba(73, 69, 255, 0.4)'
        }
      };

      const secondaryButtonStyle = {
        ...buttonStyle,
        backgroundColor: '#ffffff',
        color: '#4945FF',
        border: '1px solid #dcdce4',
        '&:hover': {
          backgroundColor: '#f0f0ff',
          borderColor: '#4945FF'
        }
      };

      const fileInputStyle = {
        display: 'none'
      };

      const fileInputLabelStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '10px 16px',
        borderRadius: '4px',
        border: '1px dashed #4945FF',
        backgroundColor: '#f0f0ff',
        color: '#4945FF',
        fontWeight: '500',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        marginBottom: '16px',
        '&:hover': {
          backgroundColor: '#e6e6ff',
          boxShadow: '0 2px 4px rgba(73, 69, 255, 0.1)'
        }
      };

      const fileNameStyle = {
        marginLeft: '8px',
        fontSize: '14px',
        color: '#666687'
      };

      const formGroupStyle = {
        marginBottom: '20px'
      };

      const errorStyle = {
        backgroundColor: '#fcecea',
        color: '#d02b20',
        padding: '12px 16px',
        borderRadius: '4px',
        fontSize: '14px',
        marginBottom: '20px',
        border: '1px solid #f5c0b8'
      };

      const infoBoxStyle = {
        backgroundColor: '#eaf5ff',
        border: '1px solid #b8e1ff',
        borderRadius: '4px',
        padding: '16px',
        color: '#006096',
        marginBottom: '20px'
      };

      const tableStyle = {
        width: '100%',
        borderCollapse: 'separate',
        borderSpacing: 0,
        border: '1px solid #eaeaea',
        borderRadius: '4px',
        overflow: 'hidden'
      };

      const tableHeaderStyle = {
        backgroundColor: '#f6f6f9',
        color: '#666687',
        fontSize: '12px',
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      };

      const tableHeaderCellStyle = {
        padding: '12px 16px',
        textAlign: 'left',
        borderBottom: '1px solid #eaeaea'
      };

      const tableCellStyle = {
        padding: '12px 16px',
        borderBottom: '1px solid #eaeaea',
        fontSize: '14px'
      };

      const checkboxStyle = {
        cursor: 'pointer',
        width: '16px',
        height: '16px'
      };

      const successStyle = {
        color: '#328048',
        backgroundColor: '#eafbe7',
        padding: '16px',
        borderRadius: '4px',
        marginBottom: '20px',
        border: '1px solid #c6f0c2'
      };

      const buttonContainerStyle = {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '12px',
        marginTop: '24px'
      };

      const duplicateItemStyle = {
        backgroundColor: 'white',
        border: '1px solid #eaeaea',
        borderRadius: '4px',
        padding: '16px',
        marginBottom: '12px',
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.05)',
        transition: 'all 0.2s ease',
        '&:hover': {
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
        }
      };

      const duplicateContainerStyle = {
        maxHeight: '400px', 
        overflowY: 'auto',
        padding: '4px',
        marginBottom: '20px'
      };

      const columnStyle = {
        flex: 1
      };

      const downloadButtonStyle = {
        ...secondaryButtonStyle,
        backgroundColor: '#4CAF50',
        color: 'white',
        borderColor: '#4CAF50',
        '&:hover': {
          backgroundColor: '#43a047',
          boxShadow: '0 2px 6px rgba(76, 175, 80, 0.3)'
        }
      };

      const requiredFieldsListStyle = {
        margin: '0 0 0 1.5rem',
        padding: 0,
        columns: '2',
        fontSize: '13px',
        color: '#666687'
      };

      const requiredFieldsHeaderStyle = {
        marginBottom: '8px',
        fontWeight: '500',
        color: '#32324d',
        fontSize: '14px'
      };

      // Render duplicate confirmation content
      const renderDuplicateContent = () => {
        return (
          <>
            <h2 style={modalHeaderStyle}>Duplicate URLs Found</h2>
            
            <div style={infoBoxStyle}>
              <p style={{ margin: '0 0 8px 0' }}>We found {duplicates.duplicates.length} URLs that already exist. Select the ones you want to update.</p>
              <p style={{ margin: 0 }}>{createdCount} new records were already created.</p>
            </div>
            
            <div style={duplicateContainerStyle}>
              {duplicates.duplicates.map((dup, index) => (
                <div key={index} style={duplicateItemStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                    <input
                      type="checkbox"
                      id={`dup-${index}`}
                      checked={selectedDuplicates.includes(dup.url)}
                      onChange={() => handleDuplicateToggle(dup.url)}
                      style={checkboxStyle}
                    />
                    <label htmlFor={`dup-${index}`} style={{ 
                      fontWeight: 'bold', 
                      marginLeft: '10px',
                      color: '#32324d',
                      flex: 1,
                      textDecoration: 'underline',
                      textDecorationColor: '#4945FF'
                    }}>
                      {dup.url}
                    </label>
                  </div>
                  
                  <div style={{ display: 'flex', marginLeft: '25px', gap: '24px' }}>
                    <div style={columnStyle}>
                      <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#666687' }}>Current Data</h4>
                      <div style={{ fontSize: '13px', lineHeight: '1.5' }}>
                        <div>Price: <span style={{ fontWeight: '500' }}>${dup.existingData.price}</span></div>
                        <div>Publisher: <span style={{ fontWeight: '500' }}>{dup.existingData.publisher_name || 'N/A'}</span></div>
                        <div>Publisher Email: <span style={{ fontWeight: '500' }}>{dup.existingData.publisher_email || 'N/A'}</span></div>
                        <div>Publisher Price: <span style={{ fontWeight: '500' }}>${dup.existingData.publisher_price || 'N/A'}</span></div>
                      </div>
                    </div>
                    <div style={columnStyle}>
                      <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#009f26' }}>New Data</h4>
                      <div style={{ fontSize: '13px', lineHeight: '1.5' }}>
                        <div>Price: <span style={{ fontWeight: '500', color: dup.newData.price !== dup.existingData.price ? '#009f26' : 'inherit' }}>${dup.newData.price}</span></div>
                        <div>Publisher: <span style={{ fontWeight: '500', color: dup.newData.publisher_name !== dup.existingData.publisher_name ? '#009f26' : 'inherit' }}>{dup.newData.publisher_name || 'N/A'}</span></div>
                        <div>Publisher Email: <span style={{ fontWeight: '500', color: dup.newData.publisher_email !== dup.existingData.publisher_email ? '#009f26' : 'inherit' }}>{dup.newData.publisher_email || 'N/A'}</span></div>
                        <div>Publisher Price: <span style={{ fontWeight: '500', color: dup.newData.publisher_price !== dup.existingData.publisher_price ? '#009f26' : 'inherit' }}>${dup.newData.publisher_price || 'N/A'}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button 
                onClick={handleDownloadDuplicates}
                style={downloadButtonStyle}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: '8px' }}>
                  <path d="M12 16L12 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M9 13L12 16L15 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M20 20H4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Download List
              </button>
              
              <div style={{ display: 'flex', gap: '12px' }}>
                <button 
                  onClick={() => setDuplicates(null)}
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
                <button 
                  onClick={handleConfirmDuplicates}
                  disabled={isUploading || selectedDuplicates.length === 0}
                  style={{
                    ...primaryButtonStyle,
                    opacity: selectedDuplicates.length > 0 ? 1 : 0.6,
                    cursor: selectedDuplicates.length > 0 ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isUploading ? (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ 
                        animation: 'spin 1s linear infinite',
                        marginRight: '8px'
                      }}>
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="calc(3.14 * 20)" strokeDashoffset="calc(3.14 * 10)" />
                      </svg>
                      Updating...
                    </>
                  ) : `Update Selected (${selectedDuplicates.length})`}
                </button>
              </div>
            </div>
          </>
        );
      };

      return (
        <>
          <div style={modalOverlayStyle} onClick={() => setIsVisible(false)}>
            <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
              {duplicates ? (
                renderDuplicateContent()
              ) : (
                <>
                  <h2 style={modalHeaderStyle}>Import from CSV</h2>
                  
                  {error && (
                    <div style={errorStyle}>{error}</div>
                  )}
                  
                  <div style={formGroupStyle}>
                    <input
                      type="file"
                      id="csv-upload"
                      accept=".csv"
                      onChange={handleFileChange}
                      style={fileInputStyle}
                    />
                    <label htmlFor="csv-upload" style={fileInputLabelStyle}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: '8px' }}>
                        <path d="M12 8L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M15 11L12 8L9 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M8 4H6C4.89543 4 4 4.89543 4 6V18C4 19.1046 4.89543 20 6 20H18C19.1046 20 20 19.1046 20 18V6C20 4.89543 19.1046 4 18 4H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Select CSV File
                    </label>
                    {file && <span style={fileNameStyle}>{file.name}</span>}
                  </div>

                  <div style={infoBoxStyle}>
                    <h4 style={requiredFieldsHeaderStyle}>Required columns:</h4>
                    <ul style={requiredFieldsListStyle}>
                      {REQUIRED_FIELDS.map((field, index) => (
                        <li key={index} style={{ marginBottom: '4px' }}>{field}</li>
                      ))}
                      {MISSING_FIELDS.filter(field => !REQUIRED_FIELDS.includes(field)).map((field, index) => (
                        <li key={index} style={{ marginBottom: '4px', color: '#8e8ea9' }}>{field}</li>
                      ))}
                    </ul>
                  </div>

                  <div style={buttonContainerStyle}>
                    <button
                      onClick={() => setIsVisible(false)}
                      style={secondaryButtonStyle}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleUpload}
                      disabled={!file || isUploading}
                      style={{
                        ...primaryButtonStyle,
                        opacity: file && !isUploading ? 1 : 0.6,
                        cursor: file && !isUploading ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {isUploading ? (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ 
                            animation: 'spin 1s linear infinite',
                            marginRight: '8px'
                          }}>
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="calc(3.14 * 20)" strokeDashoffset="calc(3.14 * 10)" />
                          </svg>
                          Uploading...
                        </>
                      ) : 'Upload'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <style>
            {`
              @keyframes modalFadeIn {
                from { opacity: 0; transform: translateY(-20px); }
                to { opacity: 1; transform: translateY(0); }
              }
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}
          </style>
        </>
      );
    };

    // CSV Export Component
    const ExportModal = ({ isVisible, setIsVisible }) => {
      const [filterEmail, setFilterEmail] = useState('');
      const [filterUrl, setFilterUrl] = useState('');
      const [filterCategory, setFilterCategory] = useState([]);
      const [filterOtherCategory, setFilterOtherCategory] = useState([]);
      const [filterLanguage, setFilterLanguage] = useState([]);
      const [filterCountry, setFilterCountry] = useState([]);
      const [filterDomainZone, setFilterDomainZone] = useState('');
      const [filterBacklinkType, setFilterBacklinkType] = useState('');
      const [filterPublisherName, setFilterPublisherName] = useState('');
      const [filterMinDR, setFilterMinDR] = useState('');
      const [filterMaxDR, setFilterMaxDR] = useState('');
      const [filterMinDA, setFilterMinDA] = useState('');
      const [filterMaxDA, setFilterMaxDA] = useState('');
      const [filterMinPrice, setFilterMinPrice] = useState('');
      const [filterMaxPrice, setFilterMaxPrice] = useState('');
      const [filterMinWordCount, setFilterMinWordCount] = useState('');
      const [filterDofollow, setFilterDofollow] = useState('');
      const [filterFastPlacement, setFilterFastPlacement] = useState('');
      const [filterMinAhrefsTraffic, setFilterMinAhrefsTraffic] = useState('');
      const [filterMinSemrushTraffic, setFilterMinSemrushTraffic] = useState('');
      const [filterMinSimilarwebTraffic, setFilterMinSimilarwebTraffic] = useState('');
      const [filterMaxAhrefsTraffic, setFilterMaxAhrefsTraffic] = useState('');
      const [filterMaxSemrushTraffic, setFilterMaxSemrushTraffic] = useState('');
      const [filterMaxSimilarwebTraffic, setFilterMaxSimilarwebTraffic] = useState('');
      const [startRecord, setStartRecord] = useState(1);
      const [endRecord, setEndRecord] = useState(1000);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [totalCount, setTotalCount] = useState(0);
      const [records, setRecords] = useState([]);
      const [selectedRecords, setSelectedRecords] = useState([]);
      const [searchPerformed, setSearchPerformed] = useState(false);
      const [currentPage, setCurrentPage] = useState(1);
      const [pageCount, setPageCount] = useState(1);
      const [categoriesDropdownOpen, setCategoriesDropdownOpen] = useState(false);
      const [otherCategoriesDropdownOpen, setOtherCategoriesDropdownOpen] = useState(false);
      const [languagesDropdownOpen, setLanguagesDropdownOpen] = useState(false);
      const [countriesDropdownOpen, setCountriesDropdownOpen] = useState(false);
      const [availableCategories, setAvailableCategories] = useState([]);
      const [availableOtherCategories, setAvailableOtherCategories] = useState([]);
      const [availableLanguages, setAvailableLanguages] = useState([]);
      const [availableCountries, setAvailableCountries] = useState([]);
      const pageSize = 50; // Number of records per page

      // Mock data for available values from enum - you should replace with real data
      useEffect(() => {
        // In a real implementation, these would be fetched from your API
        setAvailableCategories([
          "Agriculture",
          "Animals & Pets",
          "Arms and ammunition",
          "Arts & Entertainment",
          "Automobiles",
          "Beauty",
          "Blogging",
          "Business",
          "Career & Employment",
          "Computer & Electronics",
          "Coupons Offers & Cashback",
          "Cryptocurrency",
          "Digital Marketing",
          "Ecommerce",
          "Education",
          "Environment",
          "Family",
          "Fashion & Lifestyle",
          "Finance",
          "Food & Drink",
          "Games",
          "General",
          "Gift",
          "Health & Fitness",
          "Home & Garden",
          "Humor",
          "Internet & Telecom",
          "Law & Government",
          "Leisure & Hobbies",
          "Magazine",
          "Manufacturing",
          "Marketing & Advertising",
          "Music",
          "News & Media",
          "Photography",
          "Politics",
          "Quotes",
          "Real estate",
          "Region",
          "Reviews",
          "SaaS",
          "Science",
          "Shopping",
          "Spanish",
          "Sports",
          "Sprituality",
          "Technology",
          "Travelling",
          "Web development",
          "Wedding"
        ]);
        
        setAvailableOtherCategories([
          "Casino",
          "CBD/Marijuana",
          "Cryptocurrency",
          "Rehabilitation",
          "Sports Betting",
          "Vape",
          "Adult"
        ]);
        
        setAvailableLanguages([
          "English",
          "Spanish",
          "French",
          "German",
          "Italian",
          "Portuguese",
          "Dutch",
          "Russian",
          "Chinese (Simplified)",
          "Chinese (Traditional)",
          "Japanese",
          "Korean",
          "Arabic",
          "Turkish",
          "Hindi",
          "Bengali",
          "Urdu",
          "Vietnamese",
          "Thai",
          "Polish",
          "Romanian",
          "Swedish",
          "Danish",
          "Norwegian",
          "Finnish",
          "Czech",
          "Hungarian",
          "Greek",
          "Slovak",
          "Bulgarian",
          "Serbian",
          "Croatian",
          "Ukrainian",
          "Lithuanian",
          "Latvian",
          "Estonian",
          "Slovenian",
          "Hebrew",
          "Farsi (Persian)",
          "Malay",
          "Indonesian",
          "Tamil",
          "Kannada",
          "Gujarati",
          "Marathi",
          "Nepali",
          "Sinhala",
          "Burmese",
          "Khmer (Cambodian)",
          "Lao",
          "Pashto",
          "Swahili",
          "Hausa",
          "Amharic",
          "Yoruba",
          "Igbo",
          "Zulu",
          "Afrikaan",
          "Filipino (Tagalog)",
          "Bosnian",
          "Macedonian",
          "Armenian",
          "Georgian",
          "Azerbaijani",
          "Kazakh",
          "Uzbek"
        ]);
        
        setAvailableCountries([
          "Antigua and Barbuda",
          "Bahamas",
          "Barbados",
          "Belize",
          "Canada",
          "Costa Rica",
          "Cuba",
          "Dominica",
          "Dominican Republic",
          "El Salvador",
          "Grenada",
          "Guatemala",
          "Haiti",
          "Honduras",
          "Jamaica",
          "Mexico",
          "Nicaragua",
          "Panama",
          "Saint Kitts and Nevis",
          "Saint Lucia",
          "Saint Vincent and the Grenadines",
          "Trinidad and Tobago",
          "United States of America",
          "Argentina",
          "Bolivia",
          "Brazil",
          "Chile",
          "Colombia",
          "Ecuador",
          "Guyana",
          "Paraguay",
          "Peru",
          "Suriname",
          "Uruguay",
          "Venezuela",
          "Albania",
          "Andorra",
          "Armenia",
          "Austria",
          "Azerbaijan",
          "Belarus",
          "Belgium",
          "Bosnia and Herzegovina",
          "Bulgaria",
          "Croatia",
          "Cyprus",
          "Czech Republic (Czechia)",
          "Denmark",
          "Estonia",
          "Finland",
          "France",
          "Georgia",
          "Germany",
          "Greece",
          "Hungary",
          "Iceland",
          "Ireland",
          "Italy",
          "Kazakhstan",
          "Kosovo",
          "Latvia",
          "Liechtenstein",
          "Lithuania",
          "Luxembourg",
          "Malta",
          "Moldova",
          "Monaco",
          "Montenegro",
          "Netherlands",
          "North Macedonia",
          "Norway",
          "Poland",
          "Portugal",
          "Romania",
          "Russia",
          "San Marino",
          "Serbia",
          "Slovakia",
          "Slovenia",
          "Spain",
          "Sweden",
          "Switzerland",
          "Ukraine",
          "United Kingdom",
          "Vatican City (Holy See)",
          "Algeria",
          "Angola",
          "Benin",
          "Botswana",
          "Burkina Faso",
          "Burundi",
          "Cabo Verde",
          "Cameroon",
          "Central African Republic",
          "Chad",
          "Comoros",
          "Congo (Brazzaville)",
          "Congo (Kinshasa)",
          "Djibouti",
          "Egypt",
          "Equatorial Guinea",
          "Eritrea",
          "Eswatini",
          "Ethiopia",
          "Gabon",
          "Gambia",
          "Ghana",
          "Guinea",
          "Guinea-Bissau",
          "Ivory Coast (Côte d'Ivoire)",
          "Kenya",
          "Lesotho",
          "Liberia",
          "Libya",
          "Madagascar",
          "Malawi",
          "Mali",
          "Mauritania",
          "Mauritius",
          "Morocco",
          "Mozambique",
          "Namibia",
          "Niger",
          "Nigeria",
          "Rwanda",
          "São Tomé and Príncipe",
          "Senegal",
          "Seychelles",
          "Sierra Leone",
          "Somalia",
          "South Africa",
          "South Sudan",
          "Sudan",
          "Tanzania",
          "Togo",
          "Tunisia",
          "Uganda",
          "Zambia",
          "Zimbabwe",
          "Afghanistan",
          "Bahrain",
          "Bangladesh",
          "Bhutan",
          "Brunei",
          "Cambodia",
          "China",
          "India",
          "Indonesia",
          "Iran",
          "Iraq",
          "Israel",
          "Japan",
          "Jordan",
          "Kuwait",
          "Kyrgyzstan",
          "Laos",
          "Lebanon",
          "Malaysia",
          "Maldives",
          "Mongolia",
          "Myanmar (Burma)",
          "Nepal",
          "North Korea",
          "Oman",
          "Pakistan",
          "Palestine",
          "Philippines",
          "Qatar",
          "Saudi Arabia",
          "Singapore",
          "South Korea",
          "Sri Lanka",
          "Syria",
          "Taiwan",
          "Tajikistan",
          "Thailand",
          "Timor-Leste",
          "Turkmenistan",
          "United Arab Emirates",
          "Uzbekistan",
          "Vietnam",
          "Yemen",
          "Australia",
          "Fiji",
          "Kiribati",
          "Marshall Islands",
          "Micronesia",
          "Nauru",
          "New Zealand",
          "Palau",
          "Papua New Guinea",
          "Samoa",
          "Solomon Islands",
          "Tonga",
          "Tuvalu",
          "Vanuatu"
        ]);
      }, []);

      // Add useEffect for initializing data
      useEffect(() => {
        // Fetch filter options and initialize data
        const fetchInitialData = async () => {
          try {
            // ... existing code ...
            // Make sure dofollow values are set correctly
            setFilterDofollow('');
          } catch (error) {
            console.error('Error fetching initial data:', error);
          }
        };

        fetchInitialData();
      }, []);

      // Multi-select dropdown component
      const MultiSelectDropdown = ({ 
        label, 
        options, 
        selected, 
        onChange, 
        isOpen, 
        setIsOpen,
        placeholder
      }) => {
        const dropdownRef = React.useRef(null);
        
        // Add dark mode detection
        const [isDarkMode, setIsDarkMode] = useState(false);
        
        useEffect(() => {
          // Check for dark mode
          const checkDarkMode = () => {
            // Check if the Strapi admin interface has dark mode enabled
            const isDark = document.documentElement.classList.contains('strapi--dark-mode') || 
                          document.body.classList.contains('strapi--dark-mode') ||
                          window.matchMedia('(prefers-color-scheme: dark)').matches;
            setIsDarkMode(isDark);
          };
          
          // Initial check
          checkDarkMode();
          
          // Set up observer to detect theme changes in DOM
          const observer = new MutationObserver(checkDarkMode);
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
          
          // Also listen for system preference changes
          const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
          const handleChange = () => checkDarkMode();
          mediaQuery.addEventListener('change', handleChange);
          
          return () => {
            observer.disconnect();
            mediaQuery.removeEventListener('change', handleChange);
          };
        }, []);
        
        useEffect(() => {
          const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
              setIsOpen(false);
            }
          };
          
          document.addEventListener('mousedown', handleClickOutside);
          return () => {
            document.removeEventListener('mousedown', handleClickOutside);
          };
        }, [setIsOpen]);
        
        const handleOptionClick = (option) => {
          const newSelected = [...selected];
          const index = newSelected.indexOf(option);
          
          if (index === -1) {
            newSelected.push(option);
          } else {
            newSelected.splice(index, 1);
          }
          
          onChange(newSelected);
        };
        
        const handleSelectAll = () => {
          if (selected.length === options.length) {
            onChange([]);
          } else {
            onChange([...options]);
          }
        };
        
        const dropdownStyle = {
          position: 'relative',
          width: '100%',
        };
        
        const triggerStyle = {
          ...inputStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none',
          background: isDarkMode ? '#333344' : colors.white,
          color: isDarkMode ? colors.white : colors.text,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          minHeight: '38px',
        };
        
        const menuStyle = {
          position: 'absolute',
          top: '100%',
          left: 0,
          width: '100%',
          background: isDarkMode ? '#333344' : colors.white,
          border: `1px solid ${isDarkMode ? '#444455' : colors.border}`,
          borderRadius: borderRadius.sm,
          boxShadow: boxShadow.medium,
          zIndex: 10,
          maxHeight: '250px',
          overflowY: 'auto',
          marginTop: '2px',
        };
        
        const optionStyle = {
          padding: '8px 12px',
          borderBottom: `1px solid ${isDarkMode ? '#444455' : colors.border}`,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '14px',
          transition: 'background-color 0.2s',
          '&:hover': {
            backgroundColor: isDarkMode ? '#444455' : colors.secondary,
          },
        };
        
        const searchInputStyle = {
          padding: '8px 12px',
          borderBottom: `1px solid ${isDarkMode ? '#444455' : colors.border}`,
          width: '100%',
          border: 'none',
          outline: 'none',
          fontSize: '14px',
          background: isDarkMode ? '#333344' : colors.white,
          color: isDarkMode ? colors.white : colors.text,
        };
        
        const checkboxStyle = {
          marginRight: '8px',
          accentColor: colors.primary,
        };
        
        const selectedDisplay = selected.length > 0 
          ? `${selected.length} selected`
          : placeholder || 'Select options';
        
        const [searchTerm, setSearchTerm] = useState('');
        
        const filteredOptions = options.filter(option => 
          option.toLowerCase().includes(searchTerm.toLowerCase())
        );
        
        return (
          <div style={{width: '100%'}}>
            <label style={labelStyle}>{label}</label>
            <div style={dropdownStyle} ref={dropdownRef}>
              <div 
                style={triggerStyle} 
                onClick={() => setIsOpen(!isOpen)}
              >
                <span style={{
                  overflow: 'hidden', 
                  textOverflow: 'ellipsis', 
                  whiteSpace: 'nowrap',
                  color: selected.length > 0 
                    ? (isDarkMode ? colors.white : colors.text) 
                    : (isDarkMode ? '#cccccc' : colors.textLight)
                }}>
                  {selectedDisplay}
                </span>
                <svg 
                  width="12" 
                  height="12" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  xmlns="http://www.w3.org/2000/svg"
                  style={{
                    transition: 'transform 0.2s',
                    transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    color: colors.textSecondary
                  }}
                >
                  <path d="M6 9L12 15L18 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              
              {isOpen && (
                <div style={menuStyle}>
                  <input
                    type="text"
                    placeholder="Search..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={searchInputStyle}
                    onClick={(e) => e.stopPropagation()}
                  />
                  
                  <div style={{
                    ...optionStyle,
                    fontWeight: 'bold',
                    background: isDarkMode ? '#444455' : colors.secondary,
                    color: isDarkMode ? colors.white : colors.text,
                  }}>
                    <input
                      type="checkbox"
                      checked={selected.length === options.length}
                      onChange={handleSelectAll}
                      style={checkboxStyle}
                    />
                    <span>{selected.length === options.length ? 'Deselect All' : 'Select All'}</span>
                  </div>
                  
                  {filteredOptions.map((option, index) => (
                    <div 
                      key={index} 
                      style={{
                        ...optionStyle,
                        backgroundColor: selected.includes(option) 
                          ? (isDarkMode ? `${colors.primary}40` : `${colors.primary}10`) 
                          : (isDarkMode ? '#333344' : colors.white),
                        color: isDarkMode ? colors.white : colors.text,
                      }}
                      onClick={() => handleOptionClick(option)}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(option)}
                        onChange={() => {}}
                        style={checkboxStyle}
                      />
                      <span>{option}</span>
                    </div>
                  ))}
                  
                  {filteredOptions.length === 0 && (
                    <div style={{
                      padding: '12px', 
                      color: isDarkMode ? '#cccccc' : colors.textLight, 
                      textAlign: 'center'
                    }}>
                      No matching options
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      };

      // Build filter object based on all filters - updated to handle arrays
      const buildFilters = () => {
        const filters = {};
        if (filterEmail && filterEmail.trim()) {
          filters['filters[publisher_email][$containsi]'] = filterEmail.trim();
        }
        if (filterUrl && filterUrl.trim()) {
          filters['filters[url][$containsi]'] = filterUrl.trim();
        }
        
        // Handle categories - multiple selection
        if (filterCategory && filterCategory.length > 0) {
          // Using multiple containsi filters
          filterCategory.forEach((category, index) => {
            filters[`filters[category][$containsi][${index}]`] = category;
          });
        }
        
        // Handle other categories - multiple selection
        if (filterOtherCategory && filterOtherCategory.length > 0) {
          // Using multiple containsi filters
          filterOtherCategory.forEach((otherCategory, index) => {
            filters[`filters[other_category][$containsi][${index}]`] = otherCategory;
          });
        }
        
        // Handle languages - multiple selection
        if (filterLanguage && filterLanguage.length > 0) {
          // Using multiple containsi filters
          filterLanguage.forEach((language, index) => {
            filters[`filters[language][$containsi][${index}]`] = language;
          });
        }
        
        // Handle countries - multiple selection
        if (filterCountry && filterCountry.length > 0) {
          // Using multiple containsi filters
          filterCountry.forEach((country, index) => {
            filters[`filters[countries][$containsi][${index}]`] = country;
          });
        }
        
        if (filterDomainZone && filterDomainZone.trim()) {
          filters['filters[url][$endsWith]'] = filterDomainZone.trim();
        }
        if (filterBacklinkType && filterBacklinkType.trim()) {
          filters['filters[backlink_type][$eq]'] = filterBacklinkType.trim();
        }
        if (filterPublisherName && filterPublisherName.trim()) {
          filters['filters[publisher_name][$containsi]'] = filterPublisherName.trim();
        }
        if (filterMinDR && !isNaN(parseInt(filterMinDR))) {
          filters['filters[ahrefs_dr][$gte]'] = parseInt(filterMinDR);
        }
        if (filterMaxDR && !isNaN(parseInt(filterMaxDR))) {
          filters['filters[ahrefs_dr][$lte]'] = parseInt(filterMaxDR);
        }
        if (filterMinDA && !isNaN(parseInt(filterMinDA))) {
          filters['filters[moz_da][$gte]'] = parseInt(filterMinDA);
        }
        if (filterMaxDA && !isNaN(parseInt(filterMaxDA))) {
          filters['filters[moz_da][$lte]'] = parseInt(filterMaxDA);
        }
        if (filterMinPrice && !isNaN(parseInt(filterMinPrice))) {
          filters['filters[price][$gte]'] = parseInt(filterMinPrice);
        }
        if (filterMaxPrice && !isNaN(parseInt(filterMaxPrice))) {
          filters['filters[price][$lte]'] = parseInt(filterMaxPrice);
        }
        if (filterMinWordCount && !isNaN(parseInt(filterMinWordCount))) {
          filters['filters[min_word_count][$gte]'] = parseInt(filterMinWordCount);
        }
        if (filterDofollow && filterDofollow !== '') {
          console.log('Setting dofollow filter:', filterDofollow, 'type:', typeof filterDofollow);
          // Convert string to integer explicitly
          const dofollowValue = parseInt(filterDofollow, 10);
          console.log('Converted dofollow value:', dofollowValue, 'type:', typeof dofollowValue);
          filters['filters[dofollow_link][$eq]'] = dofollowValue;
        }
        if (filterFastPlacement && filterFastPlacement !== '') {
          filters['filters[fast_placement_status][$eq]'] = filterFastPlacement === 'true';
        }
        if (filterMinAhrefsTraffic && !isNaN(parseInt(filterMinAhrefsTraffic))) {
          filters['filters[ahrefs_traffic][$gte]'] = parseInt(filterMinAhrefsTraffic);
        }
        if (filterMaxAhrefsTraffic && !isNaN(parseInt(filterMaxAhrefsTraffic))) {
          filters['filters[ahrefs_traffic][$lte]'] = parseInt(filterMaxAhrefsTraffic);
        }
        if (filterMinSemrushTraffic && !isNaN(parseInt(filterMinSemrushTraffic))) {
          filters['filters[semrush_traffic][$gte]'] = parseInt(filterMinSemrushTraffic);
        }
        if (filterMaxSemrushTraffic && !isNaN(parseInt(filterMaxSemrushTraffic))) {
          filters['filters[semrush_traffic][$lte]'] = parseInt(filterMaxSemrushTraffic);
        }
        if (filterMinSimilarwebTraffic && !isNaN(parseInt(filterMinSimilarwebTraffic))) {
          filters['filters[similarweb_traffic][$gte]'] = parseInt(filterMinSimilarwebTraffic);
        }
        if (filterMaxSimilarwebTraffic && !isNaN(parseInt(filterMaxSimilarwebTraffic))) {
          filters['filters[similarweb_traffic][$lte]'] = parseInt(filterMaxSimilarwebTraffic);
        }

        console.log('Built filters:', filters);
        return filters;
      };

      // Reset all filters - updated for arrays
      const resetFilters = () => {
        setFilterEmail('');
        setFilterUrl('');
        setFilterCategory([]);
        setFilterOtherCategory([]);
        setFilterLanguage([]);
        setFilterCountry([]);
        setFilterDomainZone('');
        setFilterBacklinkType('');
        setFilterPublisherName('');
        setFilterMinDR('');
        setFilterMaxDR('');
        setFilterMinDA('');
        setFilterMaxDA('');
        setFilterMinPrice('');
        setFilterMaxPrice('');
        setFilterMinWordCount('');
        setFilterDofollow('');
        setFilterFastPlacement('');
        setFilterMinAhrefsTraffic('');
        setFilterMaxAhrefsTraffic('');
        setFilterMinSemrushTraffic('');
        setFilterMaxSemrushTraffic('');
        setFilterMinSimilarwebTraffic('');
        setFilterMaxSimilarwebTraffic('');
        // Reset record range to defaults
        setStartRecord(1);
        setEndRecord(1000);
        // Clear search results if any
        if (searchPerformed) {
          setSearchPerformed(false);
          setRecords([]);
          setTotalCount(0);
        }
      };

      // Check total count with current filters
      const checkTotalCount = async () => {
        setLoading(true);
        setError(null);
        try {
          const filters = buildFilters();
          
          const res = await axios.get('/api/marketplaces/admin-list', {
            params: {
              ...filters,
              page: 1,
              pageSize: 1, // Just need count
              removeDuplicates: true, // Add parameter to get accurate count without duplicates
            },
            withCredentials: true,
          });
          
          const total = res.data?.meta?.pagination?.total || 0;
          setTotalCount(total);
        } catch (err) {
          console.error('Count error:', err);
          setError('Failed to get count. Please try again.');
        } finally {
          setLoading(false);
        }
      };
      
      // Search and load records based on filters
      const handleSearch = async () => {
        setLoading(true);
        setError(null);
        try {
          const filters = buildFilters();
          
          console.log(`Requesting records with max limit: ${endRecord - startRecord + 1}`);
          
          const res = await axios.get('/api/marketplaces/admin-list', {
            params: {
              ...filters,
              page: 1, 
              pageSize: endRecord - startRecord + 1, // Request exactly maxRecords items
              limit: endRecord - startRecord + 1,
              removeDuplicates: true,
            },
            withCredentials: true,
          });
          console.log(res.data)
          console.log(`API returned ${res.data?.data?.length || 0} records, pagination total: ${res.data?.meta?.pagination?.total || 0}`);
          
          // Check for and handle duplicates in the client side too
          const uniqueItems = [];
          const seenUrls = new Set();
          
          // Filter duplicates by URL (or any other unique identifier you prefer)
          if (res.data && res.data.data) {
            res.data.data.forEach(item => {
              const url = item.url || item.attributes?.url;
              if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                uniqueItems.push(item);
              }
            });
            
            // Log if duplicates were found and removed
            if (uniqueItems.length < res.data.data.length) {
              console.log(`Removed ${res.data.data.length - uniqueItems.length} duplicate items from the results`);
            }
            
            // Limit items to exactly maxRecords
            const limitedItems = uniqueItems.slice(0, endRecord - startRecord + 1);
            console.log(`Setting records: ${limitedItems.length} items (after filtering and limiting)`);
            
            setRecords(limitedItems);
            
            // Set the total count to the actual number of visible records
            // This ensures the count display matches what's shown in the table
            const actualVisibleCount = limitedItems.length;
            console.log(`Setting total count to actual visible records: ${actualVisibleCount}`);
            setTotalCount(actualVisibleCount);
          } else {
            setRecords([]);
            setTotalCount(0);
          }
          
          // Calculate page count based on the actual items we have and pageSize for display
          const displayPageSize = pageSize;
          const visibleRecordsCount = uniqueItems.length;
          const calculatedPageCount = Math.ceil(visibleRecordsCount / displayPageSize);
          console.log(`Setting page count: ${calculatedPageCount} (based on ${visibleRecordsCount} visible records)`);
          setPageCount(calculatedPageCount);
          
          setCurrentPage(1);
          setSearchPerformed(true);
          setSelectedRecords([]);
        } catch (err) {
          console.error('Search error:', err);
          setError('Failed to fetch records. Please try again.');
        } finally {
          setLoading(false);
        }
      };
      
      // Load page of data
      const loadPage = async (page) => {
        if (page < 1 || page > pageCount || page === currentPage) return;
        
        setLoading(true);
        setError(null);
        try {
          const filters = buildFilters();
          
          // Calculate proper offset and limit to respect maxRecords
          const displayPageSize = pageSize;
          const offset = (page - 1) * displayPageSize;
          
          // Make sure we don't exceed maxRecords in total
          const remainingRecords = endRecord - startRecord - offset;
          const effectivePageSize = Math.min(displayPageSize, Math.max(0, remainingRecords));
          
          console.log(`Loading page ${page}, offset: ${offset}, effectivePageSize: ${effectivePageSize}, maxRecords: ${endRecord - startRecord + 1}`);
          
          // Don't load page if we've already reached the max records limit
          if (effectivePageSize <= 0) {
            setLoading(false);
            console.log('Skipping page load: no more records available within maxRecords limit');
            return;
          }
          
          const res = await axios.get('/api/marketplaces/admin-list', {
            params: {
              ...filters,
              page: page,
              pageSize: effectivePageSize,
              offset: offset, // Add explicit offset parameter
              limit: endRecord - startRecord + 1,
              removeDuplicates: true,
            },
            withCredentials: true,
          });
          
          console.log(`API returned ${res.data?.data?.length || 0} records for page ${page}`);
          
          // Check for and process duplicates
          const uniqueItems = [];
          const seenUrls = new Set();
          
          if (res.data && res.data.data) {
            res.data.data.forEach(item => {
              const url = item.url || item.attributes?.url;
              if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                uniqueItems.push(item);
              }
            });
            
            if (uniqueItems.length < res.data.data.length) {
              console.log(`Removed ${res.data.data.length - uniqueItems.length} duplicate items from page ${page}`);
            }
            
            setRecords(uniqueItems);
          } else {
            setRecords([]);
          }
          
          setCurrentPage(page);
        } catch (err) {
          console.error('Page fetch error:', err);
          setError('Failed to fetch page. Please try again.');
        } finally {
          setLoading(false);
        }
      };
      
      // Toggle record selection
      const toggleRecordSelection = (id) => {
        setSelectedRecords(prev => {
          if (prev.includes(id)) {
            return prev.filter(recordId => recordId !== id);
          } else {
            return [...prev, id];
          }
        });
      };
      
      // Select all records on current page
      const selectAllOnPage = () => {
        const allSelected = records.every(record => selectedRecords.includes(record.id));
        
        if (allSelected) {
          // If all are selected, deselect records on this page
          setSelectedRecords(prev => prev.filter(id => !records.some(record => record.id === id)));
        } else {
          // Otherwise select all records on this page
          const pageIds = records.map(record => record.id);
          setSelectedRecords(prev => {
            const newSelected = [...prev];
            pageIds.forEach(id => {
              if (!newSelected.includes(id)) {
                newSelected.push(id);
              }
            });
            return newSelected;
          });
        }
      };
      
      // Effect to check count when modal becomes visible
      useEffect(() => {
        if (isVisible) {
          checkTotalCount();
          // Reset state when modal opens
          setSearchPerformed(false);
          setRecords([]);
          setSelectedRecords([]);
        }
      }, [isVisible]);
      
      // Export selected records
      const handleExportSelected = async () => {
        if (selectedRecords.length === 0) {
          setError('Please select at least one record to export');
          return;
        }
        
        setLoading(true);
        setError(null);
        try {
          // Check for duplicate IDs in selected records
          const uniqueIds = new Set(selectedRecords);
          if (uniqueIds.size !== selectedRecords.length) {
            console.warn(`Found ${selectedRecords.length - uniqueIds.size} duplicate IDs in selection`);
            // Continue with unique IDs only
            const uniqueIdArray = [...uniqueIds];
            setSelectedRecords(uniqueIdArray);
            console.log(`Proceeding with ${uniqueIdArray.length} unique records`);
          }
          
          // Get auth token from localStorage, sessionStorage, or cookies
          let token = null;
          
          try {
            token = localStorage.getItem('jwtToken') || localStorage.getItem('jwt') || 
                   sessionStorage.getItem('jwtToken') || sessionStorage.getItem('jwt');
          } catch (e) {
            console.log('Error getting token from storage:', e);
          }
          
          // If not found in storage, try to get from cookies
          if (!token) {
            const cookies = document.cookie.split(';');
            for (let i = 0; i < cookies.length; i++) {
              const cookie = cookies[i].trim();
              if (cookie.startsWith('jwtToken')) {
                const equalPos = cookie.indexOf('=');
                if (equalPos !== -1) {
                  token = cookie.substring(equalPos + 1);
                  break;
                }
              }
            }
          }
          
          // Make request for CSV download with unique IDs
          const response = await axios.post('/api/marketplaces/export-selected-csv', {
            ids: [...uniqueIds]
          }, {
            responseType: 'blob', // Important for file download
            withCredentials: true, // Include cookies in the request
            headers: {
              ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
              'Content-Type': 'application/json'
            }
          });
          
          // Create a download link
          const url = window.URL.createObjectURL(new Blob([response.data]));
          const link = document.createElement('a');
          link.href = url;
          link.setAttribute('download', `marketplace_export_${new Date().toISOString().split('T')[0]}.csv`);
          document.body.appendChild(link);
          link.click();
          
          // Cleanup
          window.URL.revokeObjectURL(url);
          link.remove();
        } catch (err) {
          console.error('Export error:', err.response || err);
          setError(err.response?.data?.message || err.message || 'Export failed');
        } finally {
          setLoading(false);
        }
      };
      
      // Export all filtered records
      const handleBulkExport = async () => {
        try {
          setLoading(true);
          setError(null);
          
          // Get current filters
          const filters = buildFilters();
          
          // Create query string with all filters
          const queryParams = new URLSearchParams({
            ...filters,
            startRecord: startRecord,  // Add start record
            endRecord: endRecord,     // Add end record
          }).toString();
          
          console.log(`Exporting records ${startRecord} to ${endRecord} with filters:`, filters);
          
          // Use file download approach
          window.location.href = `/api/marketplace/export-filtered?${queryParams}`;
          
          // Set short timeout just to show loading indicator
          setTimeout(() => {
            setLoading(false);
          }, 1500);
        } catch (error) {
          console.error('Error in bulk export:', error);
          setError(`Export failed: ${error.message}`);
          setLoading(false);
        }
      };

      if (!isVisible) return null;

      // Improved styling constants
      const colors = {
        primary: '#4945FF',
        primaryLight: '#F0F0FF',
        primaryDark: '#3732E5',
        secondary: '#F6F6F9',
        success: '#5CB176',
        successLight: '#EAFBE7',
        error: '#D02B20',
        errorLight: '#FCECEA',
        border: '#DCDCE4',
        text: '#32324D',
        textSecondary: '#666687',
        textLight: '#8E8EA9',
        white: '#FFFFFF',
        background: '#F5F5F5',
      };

      const spacing = {
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '24px',
        xl: '32px',
      };

      const boxShadow = {
        light: '0 1px 4px rgba(33, 33, 52, 0.1)',
        medium: '0 2px 6px rgba(33, 33, 52, 0.15)',
        heavy: '0 4px 12px rgba(33, 33, 52, 0.2)',
      };

      const borderRadius = {
        sm: '4px',
        md: '8px',
        lg: '12px',
      };

      const modalStyle = {
        background: colors.white,
        padding: spacing.lg,
        borderRadius: borderRadius.md,
        maxWidth: '1240px', // Increased from 980px to 1240px
        width: '95vw',
        margin: '40px auto',
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: boxShadow.heavy,
        border: `1px solid ${colors.border}`,
      };

      const overlayStyle = {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(33, 33, 52, 0.5)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
      };

      const headerStyle = {
        borderBottom: `1px solid ${colors.border}`,
        paddingBottom: spacing.md,
        marginBottom: spacing.lg,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      };

      const sectionStyle = {
        background: colors.white,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
        border: `1px solid ${colors.border}`,
        boxShadow: boxShadow.light,
      };

      const mainHeaderStyle = {
        color: colors.text,
        fontSize: '22px',
        fontWeight: '600',
        margin: 0,
      };

      const sectionHeaderStyle = {
        color: colors.primary,
        fontSize: '18px',
        fontWeight: '600',
        marginBottom: spacing.md,
        paddingBottom: spacing.sm,
        borderBottom: `2px solid ${colors.primary}20`,
      };

      const filterGroupStyle = {
        marginBottom: spacing.md,
        padding: spacing.md,
        backgroundColor: colors.secondary,
        borderRadius: borderRadius.sm,
      };

      const filterGroupLabelStyle = {
        fontSize: '14px',
        fontWeight: 600,
        color: colors.text,
        marginBottom: spacing.md,
      };

      const filterSettingsStyle = {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: spacing.md,
      };

      const gridStyle = {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)', // Changed from 3 to 4 columns
        gap: spacing.md,
      };

      const inputStyle = {
        width: '100%',
        padding: '8px 12px',
        borderRadius: borderRadius.sm,
        border: `1px solid ${colors.border}`,
        fontSize: '14px',
        color: colors.text,
      };

      const hintStyle = {
        fontSize: '12px',
        color: colors.textLight,
        marginTop: '4px',
      };

      const labelStyle = {
        display: 'block',
        marginBottom: spacing.xs,
        fontWeight: '500',
        color: colors.textSecondary,
        fontSize: '13px',
      };

      const buttonBaseStyle = {
        padding: '8px 16px',
        borderRadius: borderRadius.sm,
        fontWeight: '500',
        fontSize: '14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        gap: spacing.xs,
      };

      const primaryButtonStyle = {
        ...buttonBaseStyle,
        background: colors.primary,
        color: colors.white,
        border: 'none',
        '&:hover': {
          background: colors.primaryDark,
          boxShadow: boxShadow.medium,
        },
      };

      const secondaryButtonStyle = {
        ...buttonBaseStyle,
        background: colors.secondary,
        color: colors.textSecondary,
        border: `1px solid ${colors.border}`,
        '&:hover': {
          background: colors.white,
          borderColor: colors.primary,
          color: colors.primary,
        },
      };

      const successButtonStyle = {
        ...buttonBaseStyle,
        background: colors.success,
        color: colors.white,
        border: 'none',
        '&:hover': {
          background: '#4CA568',
          boxShadow: boxShadow.medium,
        },
      };

      const tableStyle = {
        width: '100%',
        borderCollapse: 'separate',
        borderSpacing: 0,
        overflow: 'hidden',
        borderRadius: borderRadius.sm,
        border: `1px solid ${colors.border}`,
      };

      const tableHeaderStyle = {
        background: colors.secondary,
        color: colors.textSecondary,
        textAlign: 'left',
        padding: spacing.sm,
        fontSize: '13px',
        fontWeight: '600',
        borderBottom: `1px solid ${colors.border}`,
      };

      const tableCellStyle = {
        padding: spacing.sm,
        fontSize: '14px',
        borderBottom: `1px solid ${colors.border}`,
        color: colors.text,
      };

      const checkboxStyle = {
        cursor: 'pointer',
        width: '16px',
        height: '16px',
        accentColor: colors.primary,
      };

      const errorMessageStyle = {
        background: colors.errorLight,
        color: colors.error,
        padding: spacing.md,
        borderRadius: borderRadius.sm,
        marginBottom: spacing.md,
        fontSize: '14px',
        border: `1px solid ${colors.error}25`,
      };

      const infoBoxStyle = {
        background: colors.primaryLight,
        border: `1px solid ${colors.primary}25`,
        borderRadius: borderRadius.sm,
        padding: spacing.md,
        color: colors.primary,
        marginBottom: spacing.md,
        fontSize: '14px',
      };

      const paginationStyle = {
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: spacing.md,
      };

      const paginationButtonStyle = {
        ...buttonBaseStyle,
        padding: '6px 12px',
        background: colors.white,
        border: `1px solid ${colors.border}`,
        color: colors.textSecondary,
        '&:hover': {
          borderColor: colors.primary,
          color: colors.primary,
        },
      };

      const tabsStyle = {
        display: 'flex',
        borderBottom: `1px solid ${colors.border}`,
        marginBottom: spacing.md,
      };
      
      const tabStyle = {
        padding: `${spacing.sm} ${spacing.md}`,
        cursor: 'pointer',
        position: 'relative',
        color: colors.textSecondary,
        fontSize: '14px',
        fontWeight: '500',
      };

      // Handle filter changes
      const handleFilterEmailChange = (e) => {
        setFilterEmail(e.target.value);
      };
      
      const handleFilterUrlChange = (e) => {
        setFilterUrl(e.target.value);
      };
      
      const handleFilterDomainZoneChange = (e) => {
        setFilterDomainZone(e.target.value);
      };
      
      const handleFilterBacklinkTypeChange = (e) => {
        setFilterBacklinkType(e.target.value);
      };
      
      const handleFilterPublisherNameChange = (e) => {
        setFilterPublisherName(e.target.value);
      };
      
      const handleFilterMinDRChange = (e) => {
        setFilterMinDR(e.target.value);
      };
      
      const handleFilterMaxDRChange = (e) => {
        setFilterMaxDR(e.target.value);
      };
      
      const handleFilterMinDAChange = (e) => {
        setFilterMinDA(e.target.value);
      };
      
      const handleFilterMaxDAChange = (e) => {
        setFilterMaxDA(e.target.value);
      };
      
      const handleFilterMinPriceChange = (e) => {
        setFilterMinPrice(e.target.value);
      };
      
      const handleFilterMaxPriceChange = (e) => {
        setFilterMaxPrice(e.target.value);
      };
      
      const handleFilterMinWordCountChange = (e) => {
        setFilterMinWordCount(e.target.value);
      };
      
      const handleFilterDofollowChange = (e) => {
        const value = e.target.value;
        // Only convert to integer if it's not empty string
        setFilterDofollow(value === '' ? '' : value);
      };
      
      const handleFilterFastPlacementChange = (e) => {
        setFilterFastPlacement(e.target.value);
      };
      
      const handleFilterMinAhrefsTrafficChange = (e) => {
        setFilterMinAhrefsTraffic(e.target.value);
      };
      
      const handleFilterMinSemrushTrafficChange = (e) => {
        setFilterMinSemrushTraffic(e.target.value);
      };
      
      const handleFilterMinSimilarwebTrafficChange = (e) => {
        setFilterMinSimilarwebTraffic(e.target.value);
      };
      
      const handleFilterMaxAhrefsTrafficChange = (e) => {
        setFilterMaxAhrefsTraffic(e.target.value);
      };
      
      const handleFilterMaxSemrushTrafficChange = (e) => {
        setFilterMaxSemrushTraffic(e.target.value);
      };
      
      const handleFilterMaxSimilarwebTrafficChange = (e) => {
        setFilterMaxSimilarwebTraffic(e.target.value);
      };
      
      // Handle max records change
      const handleMaxRecordsChange = (e) => {
        const value = parseInt(e.target.value, 10);
        if (isNaN(value)) return;
        
        const range = value;
        // Keep the start record the same and adjust the end record to maintain the requested range size
        const newEndRecord = Math.min(startRecord + range - 1, 50000);
        setEndRecord(newEndRecord);
      };

      // Add handlers for the new inputs
      const handleStartRecordChange = (e) => {
        const value = parseInt(e.target.value, 10);
        setStartRecord(isNaN(value) ? 1 : Math.max(1, value));
      };

      const handleEndRecordChange = (e) => {
        const value = parseInt(e.target.value, 10);
        setEndRecord(isNaN(value) ? 1000 : Math.min(50000, Math.max(startRecord, value)));
      };

      return (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <div style={headerStyle}>
              <h2 style={mainHeaderStyle}>Export Marketplace Data</h2>
              <button 
                onClick={() => setIsVisible(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, fontSize: '20px' }}
              >
                ×
              </button>
            </div>
            
            {/* Filter section with improved styling */}
            <div style={sectionStyle}>
              <h3 style={sectionHeaderStyle}>Filter Records</h3>
              
              {/* Basic filters - 4 column layout */}
              <div style={filterGroupStyle}>
                <h4 style={filterGroupLabelStyle}>Basic Filters</h4>
                <div style={gridStyle}>
                  <div>
                    <label style={labelStyle}>URL:</label>
                    <input
                      type="text"
                      value={filterUrl}
                      onChange={handleFilterUrlChange}
                      placeholder="Filter by URL"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <MultiSelectDropdown
                      label="Category:"
                      options={availableCategories}
                      selected={filterCategory}
                      onChange={setFilterCategory}
                      isOpen={categoriesDropdownOpen}
                      setIsOpen={setCategoriesDropdownOpen}
                      placeholder="Select categories"
                    />
                  </div>
                  <div>
                    <MultiSelectDropdown
                      label="Other Category:"
                      options={availableOtherCategories}
                      selected={filterOtherCategory}
                      onChange={setFilterOtherCategory}
                      isOpen={otherCategoriesDropdownOpen}
                      setIsOpen={setOtherCategoriesDropdownOpen}
                      placeholder="Select other categories"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Backlink Type:</label>
                    <select
                      value={filterBacklinkType}
                      onChange={handleFilterBacklinkTypeChange}
                      style={inputStyle}
                    >
                      <option value="">Any Type</option>
                      <option value="Do follow">Do follow</option>
                      <option value="No follow">No follow</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Geo & domain filters - 4 column layout */}
              <div style={filterGroupStyle}>
                <h4 style={filterGroupLabelStyle}>Geo & Domain Filters</h4>
                <div style={gridStyle}>
                  <div>
                    <MultiSelectDropdown
                      label="Language:"
                      options={availableLanguages}
                      selected={filterLanguage}
                      onChange={setFilterLanguage}
                      isOpen={languagesDropdownOpen}
                      setIsOpen={setLanguagesDropdownOpen}
                      placeholder="Select languages"
                    />
                  </div>
                  <div>
                    <MultiSelectDropdown
                      label="Country:"
                      options={availableCountries}
                      selected={filterCountry}
                      onChange={setFilterCountry}
                      isOpen={countriesDropdownOpen}
                      setIsOpen={setCountriesDropdownOpen}
                      placeholder="Select countries"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Domain Zone:</label>
                    <input
                      type="text"
                      value={filterDomainZone}
                      onChange={handleFilterDomainZoneChange}
                      placeholder="e.g. .com, .org, .io"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Fast Placement:</label>
                    <select
                      value={filterFastPlacement}
                      onChange={handleFilterFastPlacementChange}
                      style={inputStyle}
                    >
                      <option value="">Any</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Publisher filters - 4 column layout */}
              <div style={filterGroupStyle}>
                <h4 style={filterGroupLabelStyle}>Publisher Filters</h4>
                <div style={gridStyle}>
                  <div>
                    <label style={labelStyle}>Publisher Email:</label>
                    <input
                      type="text"
                      value={filterEmail}
                      onChange={handleFilterEmailChange}
                      placeholder="Filter by publisher email"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Publisher Name:</label>
                    <input
                      type="text"
                      value={filterPublisherName}
                      onChange={handleFilterPublisherNameChange}
                      placeholder="Filter by publisher name"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Dofollow Link:</label>
                    <select
                      value={filterDofollow}
                      onChange={handleFilterDofollowChange}
                      style={inputStyle}
                    >
                      <option value="">Any</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Min Word Count:</label>
                    <input
                      type="number"
                      value={filterMinWordCount}
                      onChange={handleFilterMinWordCountChange}
                      placeholder="Min word count"
                      style={inputStyle}
                    />
                  </div>
                </div>
              </div>

              {/* Domain metrics & Price filters - combined in one row with 4 columns */}
              <div style={filterGroupStyle}>
                <h4 style={filterGroupLabelStyle}>Metrics & Price Filters</h4>
                <div style={gridStyle}>
                  <div>
                    <label style={labelStyle}>DR Range:</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="number"
                      value={filterMinDR}
                      onChange={handleFilterMinDRChange}
                        placeholder="Min"
                        style={{ ...inputStyle, width: '50%' }}
                    />
                    <input
                      type="number"
                      value={filterMaxDR}
                      onChange={handleFilterMaxDRChange}
                        placeholder="Max"
                        style={{ ...inputStyle, width: '50%' }}
                    />
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>DA Range:</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="number"
                      value={filterMinDA}
                      onChange={handleFilterMinDAChange}
                        placeholder="Min"
                        style={{ ...inputStyle, width: '50%' }}
                    />
                    <input
                      type="number"
                      value={filterMaxDA}
                      onChange={handleFilterMaxDAChange}
                        placeholder="Max"
                        style={{ ...inputStyle, width: '50%' }}
                    />
                  </div>
                </div>
                  <div>
                    <label style={labelStyle}>Price Range:</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="number"
                      value={filterMinPrice}
                      onChange={handleFilterMinPriceChange}
                        placeholder="Min"
                        style={{ ...inputStyle, width: '50%' }}
                    />
                    <input
                      type="number"
                      value={filterMaxPrice}
                      onChange={handleFilterMaxPriceChange}
                        placeholder="Max"
                        style={{ ...inputStyle, width: '50%' }}
                    />
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>Min Word Count:</label>
                    <input
                      type="number"
                      value={filterMinWordCount}
                      onChange={handleFilterMinWordCountChange}
                      placeholder="Min word count"
                      style={inputStyle}
                    />
                </div>
              </div>

                {/* New Traffic Metrics Row */}
                <div style={gridStyle}>
                  <div>
                    <label style={labelStyle}>Ahrefs Traffic Range:</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="number"
                        value={filterMinAhrefsTraffic}
                        onChange={handleFilterMinAhrefsTrafficChange}
                        placeholder="Min"
                        style={{ ...inputStyle, width: '50%' }}
                      />
                      <input
                        type="number"
                        value={filterMaxAhrefsTraffic}
                        onChange={handleFilterMaxAhrefsTrafficChange}
                        placeholder="Max"
                        style={{ ...inputStyle, width: '50%' }}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>Semrush Traffic Range:</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="number"
                        value={filterMinSemrushTraffic}
                        onChange={handleFilterMinSemrushTrafficChange}
                        placeholder="Min"
                        style={{ ...inputStyle, width: '50%' }}
                      />
                      <input
                        type="number"
                        value={filterMaxSemrushTraffic}
                        onChange={handleFilterMaxSemrushTrafficChange}
                        placeholder="Max"
                        style={{ ...inputStyle, width: '50%' }}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>Similarweb Traffic Range:</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="number"
                        value={filterMinSimilarwebTraffic}
                        onChange={handleFilterMinSimilarwebTrafficChange}
                        placeholder="Min"
                        style={{ ...inputStyle, width: '50%' }}
                      />
                      <input
                        type="number"
                        value={filterMaxSimilarwebTraffic}
                        onChange={handleFilterMaxSimilarwebTrafficChange}
                        placeholder="Max"
                        style={{ ...inputStyle, width: '50%' }}
                      />
                    </div>
                  </div>
                  <div>
                    {/* Placeholder to maintain grid alignment */}
                  </div>
                </div>
              </div>
              
              {/* Export Settings */}
              <div style={filterGroupStyle}>
                <h4 style={filterGroupLabelStyle}>Export Settings</h4>
                <div style={filterSettingsStyle}>
                  <div>
                    <label style={labelStyle}>Record Range:</label>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        type="number"
                        value={startRecord}
                        onChange={handleStartRecordChange}
                        min="1"
                        max="50000"
                        style={{ ...inputStyle, width: '45%' }}
                      />
                      <span style={{ color: colors.textSecondary }}>to</span>
                      <input
                        type="number"
                        value={endRecord}
                        onChange={handleEndRecordChange}
                        min={startRecord}
                        max="50000"
                        style={{ ...inputStyle, width: '45%' }}
                      />
                    </div>
                    <p style={hintStyle}>Maximum range: 50,000 records</p>
                  </div>
                  <div>
                    <label style={labelStyle}>Fast Placement:</label>
                    <select
                      value={filterFastPlacement}
                      onChange={handleFilterFastPlacementChange}
                      style={inputStyle}
                    >
                      <option value="">Any</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Dofollow Link:</label>
                    <select
                      value={filterDofollow}
                      onChange={handleFilterDofollowChange}
                      style={inputStyle}
                    >
                      <option value="">Any</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: spacing.md, display: 'flex', gap: spacing.md, justifyContent: 'flex-end' }}>
                <button
                  onClick={resetFilters}
                  style={secondaryButtonStyle}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.xs }}>
                    <path d="M12 20L12 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M18 12L12 6L6 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Reset Filters
                </button>
                <button
                  onClick={handleSearch}
                  disabled={loading}
                  style={{ 
                    ...primaryButtonStyle,
                    opacity: loading ? 0.7 : 1,
                    cursor: loading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {loading ? (
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ 
                        animation: 'spin 1s linear infinite',
                        marginRight: spacing.xs
                      }}>
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="calc(3.14 * 20)" strokeDashoffset="calc(3.14 * 10)" />
                      </svg>
                      Searching...
                    </span>
                  ) : (
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.xs }}>
                        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/>
                        <path d="M20 20L16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                      Search Records
                    </span>
                  )}
                </button>
              </div>
            </div>
            
            {/* Error display */}
            {error && (
              <div style={errorMessageStyle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.xs }}>
                  <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="currentColor" strokeWidth="2"/>
                  <path d="M12 8V14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="12" cy="16" r="1" fill="currentColor"/>
                </svg>
                {error}
              </div>
            )}
            
            {/* Results section */}
            {searchPerformed && (
              <div style={{
                ...sectionStyle, 
                marginTop: spacing.md,
                padding: spacing.lg,
                background: colors.white,
              }}>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center', 
                  marginBottom: spacing.lg,
                  borderBottom: `1px solid ${colors.border}`,
                  paddingBottom: spacing.md,
                }}>
                  <h3 style={{ 
                    margin: 0, 
                    color: colors.text, 
                    fontSize: '18px', 
                    fontWeight: '600',
                    display: 'flex',
                    alignItems: 'center',
                  }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.sm, color: colors.primary }}>
                      <path d="M19 21H5C3.89543 21 3 20.1046 3 19V5C3 3.89543 3.89543 3 5 3H19C20.1046 3 21 3.89543 21 5V19C21 20.1046 20.1046 21 19 21Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M16 8H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M16 12H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M16 16H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Search Results
                    <span style={{ 
                      marginLeft: spacing.sm, 
                      fontSize: '14px', 
                      fontWeight: 'normal',
                      background: colors.primaryLight,
                      color: colors.primary,
                      borderRadius: '12px',
                      padding: '2px 8px',
                    }}>
                      {records.length} records
                    </span>
                  </h3>
                  {records.length > 0 && (
                  <div>
                      <label style={{ 
                        display: 'flex', 
                        alignItems: 'center',
                        fontSize: '14px',
                        color: colors.textSecondary,
                        cursor: 'pointer',
                      }}>
                      <input 
                        type="checkbox" 
                        checked={records.length > 0 && records.every(record => selectedRecords.includes(record.id))}
                        onChange={selectAllOnPage}
                          style={{...checkboxStyle, marginRight: spacing.xs}}
                      />
                      {records.length > 0 && records.every(record => selectedRecords.includes(record.id)) 
                        ? 'Deselect All' 
                        : 'Select All'}
                    </label>
                  </div>
                  )}
                </div>

                {records.length > 0 ? (
                  <div>
                    {/* Records table with improved styling */}
                    <div style={{ 
                      overflowX: 'auto', 
                      maxHeight: '400px', 
                      borderRadius: borderRadius.sm, 
                      border: `1px solid ${colors.border}`,
                      boxShadow: boxShadow.light,
                    }}>
                      <table style={tableStyle}>
                        <thead>
                          <tr style={{ background: `${colors.primary}08` }}>
                            <th style={{
                              ...tableHeaderStyle,
                              width: '40px',
                              textAlign: 'center',
                            }}></th>
                            <th style={tableHeaderStyle}>URL</th>
                            <th style={tableHeaderStyle}>Publisher</th>
                            <th style={tableHeaderStyle}>Email</th>
                            <th style={{...tableHeaderStyle, textAlign: 'right'}}>Price</th>
                            <th style={{...tableHeaderStyle, textAlign: 'right'}}>DR</th>
                            <th style={{...tableHeaderStyle, textAlign: 'right'}}>DA</th>
                            <th style={tableHeaderStyle}>Category</th>
                            <th style={tableHeaderStyle}>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.map((record, index) => (
                            <tr key={record.id} style={{ background: index % 2 === 0 ? colors.white : colors.secondary }}>
                              <td style={{
                                ...tableCellStyle,
                                textAlign: 'center',
                              }}>
                                <input 
                                  type="checkbox" 
                                  checked={selectedRecords.includes(record.id)}
                                  onChange={() => toggleRecordSelection(record.id)}
                                  style={checkboxStyle}
                                />
                              </td>
                              <td style={tableCellStyle}>
                                <div style={{ 
                                  maxWidth: '200px', 
                                  overflow: 'hidden', 
                                  textOverflow: 'ellipsis', 
                                  whiteSpace: 'nowrap',
                                  fontWeight: '500',
                                  color: colors.primary,
                                }}>
                                  {record.url || record.attributes?.url || 'N/A'}
                                </div>
                              </td>
                              <td style={tableCellStyle}>{record.publisher_name || record.attributes?.publisher_name || 'N/A'}</td>
                              <td style={tableCellStyle}>{record.publisher_email || record.attributes?.publisher_email || 'N/A'}</td>
                              <td style={{...tableCellStyle, textAlign: 'right', fontWeight: '500'}}>${record.price || record.attributes?.price || 'N/A'}</td>
                              <td style={{...tableCellStyle, textAlign: 'right'}}>{record.ahrefs_dr || record.attributes?.ahrefs_dr || 'N/A'}</td>
                              <td style={{...tableCellStyle, textAlign: 'right'}}>{record.moz_da || record.attributes?.moz_da || 'N/A'}</td>
                              <td style={tableCellStyle}>
                                {(() => {
                                  const category = record.category || record.attributes?.category;
                                  if (!category) return 'N/A';
                                  
                                  // Handle array of categories
                                  if (Array.isArray(category)) {
                                    return category.join(', ');
                                  }
                                  
                                  // Handle string that might contain multiple categories
                                  if (typeof category === 'string' && category.includes(',')) {
                                    return category.split(',').map(cat => cat.trim()).join(', ');
                                  }
                                  
                                  return category;
                                })()}
                              </td>
                              <td style={tableCellStyle}>{record.backlink_type || record.attributes?.backlink_type || 'N/A'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination with improved styling */}
                    {pageCount > 1 && (
                      <div style={paginationStyle}>
                        <button 
                          onClick={() => loadPage(currentPage - 1)}
                          disabled={currentPage === 1 || loading}
                          style={{
                            ...paginationButtonStyle,
                            opacity: currentPage === 1 || loading ? 0.5 : 1,
                            cursor: currentPage === 1 || loading ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M15 18L9 12L15 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <span style={{ 
                          padding: spacing.xs,
                          fontSize: '14px',
                          color: colors.textSecondary,
                        }}>
                          Page {currentPage} of {pageCount}
                        </span>
                        <button 
                          onClick={() => loadPage(currentPage + 1)}
                          disabled={currentPage === pageCount || loading}
                          style={{
                            ...paginationButtonStyle,
                            opacity: currentPage === pageCount || loading ? 0.5 : 1,
                            cursor: currentPage === pageCount || loading ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M9 6L15 12L9 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      </div>
                    )}

                    {/* Selected count with badge */}
                    <div style={{ 
                      marginTop: spacing.md, 
                      padding: spacing.md, 
                      background: colors.primaryLight, 
                      borderRadius: borderRadius.sm,
                      display: 'flex',
                      alignItems: 'center',
                      border: `1px solid ${colors.primary}25`,
                    }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.sm, color: colors.primary }}>
                        <path d="M9 11L12 14L20 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M20 12V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <strong style={{ color: colors.primary }}>{selectedRecords.length} records selected</strong>
                    </div>
                  </div>
                ) : (
                  <div style={{ 
                    padding: spacing.xl, 
                    background: colors.secondary, 
                    borderRadius: borderRadius.sm, 
                    textAlign: 'center',
                    color: colors.textSecondary,
                    border: `1px solid ${colors.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginBottom: spacing.sm, color: colors.textLight }}>
                      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/>
                      <path d="M11 8V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      <path d="M11 14H11.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      <path d="M20 20L16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    <p style={{ margin: 0, fontSize: '15px' }}>No records found matching your filter criteria</p>
                  </div>
                )}
              </div>
            )}
            
            {/* Action buttons */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              gap: spacing.md, 
              marginTop: spacing.lg,
              borderTop: `1px solid ${colors.border}`,
              paddingTop: spacing.lg
            }}>
              <div>
                {searchPerformed && records.length > 0 && (
                  <button
                    onClick={handleExportSelected}
                    disabled={loading || selectedRecords.length === 0}
                    style={{ 
                      ...successButtonStyle,
                      opacity: loading || selectedRecords.length === 0 ? 0.5 : 1,
                      cursor: loading || selectedRecords.length === 0 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {loading ? (
                      <span style={{ display: 'flex', alignItems: 'center' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ 
                          animation: 'spin 1s linear infinite',
                          marginRight: spacing.xs
                        }}>
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="calc(3.14 * 20)" strokeDashoffset="calc(3.14 * 10)" />
                        </svg>
                        Processing...
                      </span>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.xs }}>
                          <path d="M12 4V14M12 14L16 10M12 14L8 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M20 16V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        Export Selected ({selectedRecords.length})
                      </span>
                    )}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: spacing.md }}>
                <button 
                  onClick={() => setIsVisible(false)} 
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkExport}
                  disabled={loading || records.length === 0}
                  style={{ 
                    ...primaryButtonStyle,
                    opacity: loading || records.length === 0 ? 0.5 : 1,
                    cursor: loading || records.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {loading ? (
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ 
                        animation: 'spin 1s linear infinite',
                        marginRight: spacing.xs
                      }}>
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="calc(3.14 * 20)" strokeDashoffset="calc(3.14 * 10)" />
                      </svg>
                      Processing...
                    </span>
                  ) : (
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: spacing.xs }}>
                        <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M7 10L12 15L17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Export All ({records.length})
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>

          <style>
            {`
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}
          </style>
        </div>
      );
    };

    // Main Injected Component
    const Injected = () => {
      const [isVisible, setIsVisible] = useState(false);
      const [exportVisible, setExportVisible] = useState(false);

      return (
        <>
          {/* CSV Import Button */}
          <button
            onClick={() => setIsVisible(true)}
            style={{
              backgroundColor: '#4945FF',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginLeft: '1rem'
            }}
          >
            <span>+</span>
            Import from CSV
          </button>
          
          {/* CSV Export Button */}
          <button
            onClick={() => setExportVisible(true)}
            style={{
              backgroundColor: '#4945FF',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginLeft: '1rem'
            }}
          >
            <span>+</span>
            Export CSV
          </button>
          
          {/* Modals */}
          {isVisible && <ImportModal setIsVisible={setIsVisible} />}
          <ExportModal isVisible={exportVisible} setIsVisible={setExportVisible} />
        </>
      );
    };

    if (plugin) {
      plugin.injectComponent('listView', 'actions', {
        name: 'csv-import',
        Component: (props) => {
          // Check if we're on a marketplace-related page
          const currentPath = window.location.pathname;
          console.log('Current path:', currentPath);
          
          // Use a more flexible check for marketplace collection
          if (
            currentPath.includes('marketplace') || 
            currentPath.includes('Marketplace') ||
            currentPath.includes('marketplaces')
          ) {
            return <Injected {...props} />;
          }
          
          // Not on marketplace page
          return null;
        }
      });
    }
  },
};
