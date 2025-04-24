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
      const [filterCategory, setFilterCategory] = useState('');
      const [filterOtherCategory, setFilterOtherCategory] = useState('');
      const [filterLanguage, setFilterLanguage] = useState('');
      const [filterCountry, setFilterCountry] = useState('');
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
      const [maxRecords, setMaxRecords] = useState(1000);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [totalCount, setTotalCount] = useState(0);
      const [records, setRecords] = useState([]);
      const [selectedRecords, setSelectedRecords] = useState([]);
      const [searchPerformed, setSearchPerformed] = useState(false);
      const [currentPage, setCurrentPage] = useState(1);
      const [pageCount, setPageCount] = useState(1);
      const pageSize = 50; // Number of records per page

      // Handle filter changes
      const handleFilterEmailChange = (e) => {
        setFilterEmail(e.target.value);
      };
      
      const handleFilterUrlChange = (e) => {
        setFilterUrl(e.target.value);
      };

      const handleFilterCategoryChange = (e) => {
        setFilterCategory(e.target.value);
      };

      // New filter handlers
      const handleFilterOtherCategoryChange = (e) => {
        setFilterOtherCategory(e.target.value);
      };
      
      const handleFilterLanguageChange = (e) => {
        setFilterLanguage(e.target.value);
      };
      
      const handleFilterCountryChange = (e) => {
        setFilterCountry(e.target.value);
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
        setFilterDofollow(e.target.value);
      };

      const handleFilterFastPlacementChange = (e) => {
        setFilterFastPlacement(e.target.value);
      };
      
      const handleMaxRecordsChange = (e) => {
        const value = parseInt(e.target.value) || 0;
        const newMaxRecords = Math.min(Math.max(value, 1), 50000); // Limit between 1 and 50000
        console.log(`Setting maxRecords: ${newMaxRecords} (from input: ${value})`);
        setMaxRecords(newMaxRecords);
        
        // If we've already done a search, update results with new limit
        if (searchPerformed) {
          console.log('Search already performed, refreshing results with new maxRecords');
          handleSearch();
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

      // Build filter object based on all filters
      const buildFilters = () => {
        const filters = {};
        if (filterEmail && filterEmail.trim()) {
          filters['filters[publisher_email][$containsi]'] = filterEmail.trim();
        }
        if (filterUrl && filterUrl.trim()) {
          filters['filters[url][$containsi]'] = filterUrl.trim();
        }
        if (filterCategory && filterCategory.trim()) {
          filters['filters[category][$containsi]'] = filterCategory.trim();
        }
        if (filterOtherCategory && filterOtherCategory.trim()) {
          filters['filters[other_category][$containsi]'] = filterOtherCategory.trim();
        }
        if (filterLanguage && filterLanguage.trim()) {
          filters['filters[language][$containsi]'] = filterLanguage.trim();
        }
        if (filterCountry && filterCountry.trim()) {
          filters['filters[country][$containsi]'] = filterCountry.trim();
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
        if (filterDofollow && filterDofollow !== 'any') {
          filters['filters[dofollow_link][$eq]'] = filterDofollow === 'yes';
        }
        if (filterFastPlacement && filterFastPlacement !== 'any') {
          filters['filters[fast_placement_status][$eq]'] = filterFastPlacement === 'yes';
        }
        return filters;
      };
      
      // Search and load records based on filters
      const handleSearch = async () => {
        setLoading(true);
        setError(null);
        try {
          const filters = buildFilters();
          
          console.log(`Requesting records with max limit: ${maxRecords}`);
          
          const res = await axios.get('/api/marketplaces/admin-list', {
            params: {
              ...filters,
              page: 1, 
              pageSize: maxRecords, // Request exactly maxRecords items
              limit: maxRecords,
              removeDuplicates: true,
            },
            withCredentials: true,
          });
          
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
            const limitedItems = uniqueItems.slice(0, maxRecords);
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
          const remainingRecords = maxRecords - offset;
          const effectivePageSize = Math.min(displayPageSize, Math.max(0, remainingRecords));
          
          console.log(`Loading page ${page}, offset: ${offset}, effectivePageSize: ${effectivePageSize}, maxRecords: ${maxRecords}`);
          
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
              limit: maxRecords,
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
        setLoading(true);
        setError(null);
        try {
          const filters = buildFilters();
          
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
          
          // Add additional parameters to request
          const params = {
            ...filters,
            limit: maxRecords,
            removeDuplicates: true // Add flag to remove duplicates on the server side
          };
          
          // Make request for CSV download
          const response = await axios.get('/api/marketplaces/export-filtered-csv', {
            params,
            responseType: 'blob', // Important for file download
            withCredentials: true, // Include cookies in the request
            headers: {
              ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
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
          setIsVisible(false);
        } catch (err) {
          console.error('Export error:', err.response || err);
          setError(err.response?.data?.message || err.message || 'Export failed');
        } finally {
          setLoading(false);
        }
      };

      if (!isVisible) return null;

      return (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.2)', zIndex: 1000 }}>
          <div style={{ background: 'white', padding: 24, borderRadius: 8, maxWidth: 900, margin: '60px auto', maxHeight: '80vh', overflowY: 'auto' }}>
            <h2>Export Marketplace Data to CSV</h2>
            
            {/* Filter section */}
            <div style={{ marginBottom: 24 }}>
              <h3>Filter Records</h3>
              
              {/* Basic filters */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Basic Filters</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>URL:</label>
                    <input
                      type="text"
                      value={filterUrl}
                      onChange={handleFilterUrlChange}
                      placeholder="Filter by URL"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Category:</label>
                    <input
                      type="text"
                      value={filterCategory}
                      onChange={handleFilterCategoryChange}
                      placeholder="Filter by category"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Backlink Type:</label>
                    <select
                      value={filterBacklinkType}
                      onChange={handleFilterBacklinkTypeChange}
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%', height: '38px' }}
                    >
                      <option value="">Any Type</option>
                      <option value="guest post">Guest Post</option>
                      <option value="link insertion">Link Insertion</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Other category filter */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Additional Categories</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(1, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Other Category:</label>
                    <input
                      type="text"
                      value={filterOtherCategory}
                      onChange={handleFilterOtherCategoryChange}
                      placeholder="Filter by other category"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              {/* Geo & domain filters */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Geo & Domain Filters</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Language:</label>
                    <input
                      type="text"
                      value={filterLanguage}
                      onChange={handleFilterLanguageChange}
                      placeholder="Filter by language"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Country:</label>
                    <input
                      type="text"
                      value={filterCountry}
                      onChange={handleFilterCountryChange}
                      placeholder="Filter by country"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Domain Zone:</label>
                    <input
                      type="text"
                      value={filterDomainZone}
                      onChange={handleFilterDomainZoneChange}
                      placeholder="e.g. .com, .org, .io"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              {/* Publisher filters */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Publisher Filters</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Publisher Email:</label>
                    <input
                      type="text"
                      value={filterEmail}
                      onChange={handleFilterEmailChange}
                      placeholder="Filter by publisher email"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Publisher Name:</label>
                    <input
                      type="text"
                      value={filterPublisherName}
                      onChange={handleFilterPublisherNameChange}
                      placeholder="Filter by publisher name"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              {/* Domain metrics filters */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Domain Metrics</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Min DR:</label>
                    <input
                      type="number"
                      value={filterMinDR}
                      onChange={handleFilterMinDRChange}
                      placeholder="Min DR"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Max DR:</label>
                    <input
                      type="number"
                      value={filterMaxDR}
                      onChange={handleFilterMaxDRChange}
                      placeholder="Max DR"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Min DA:</label>
                    <input
                      type="number"
                      value={filterMinDA}
                      onChange={handleFilterMinDAChange}
                      placeholder="Min DA"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Max DA:</label>
                    <input
                      type="number"
                      value={filterMaxDA}
                      onChange={handleFilterMaxDAChange}
                      placeholder="Max DA"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              {/* Price and content filters */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Price & Content Requirements</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Min Price ($):</label>
                    <input
                      type="number"
                      value={filterMinPrice}
                      onChange={handleFilterMinPriceChange}
                      placeholder="Min price"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Max Price ($):</label>
                    <input
                      type="number"
                      value={filterMaxPrice}
                      onChange={handleFilterMaxPriceChange}
                      placeholder="Max price"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Min Word Count:</label>
                    <input
                      type="number"
                      value={filterMinWordCount}
                      onChange={handleFilterMinWordCountChange}
                      placeholder="Min word count"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              {/* Additional filters */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontWeight: 500 }}>Additional Filters</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Dofollow Link:</label>
                    <select
                      value={filterDofollow}
                      onChange={handleFilterDofollowChange}
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%', height: '38px' }}
                    >
                      <option value="">Any</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Fast Placement:</label>
                    <select
                      value={filterFastPlacement}
                      onChange={handleFilterFastPlacementChange}
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%', height: '38px' }}
                    >
                      <option value="">Any</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Max Records:</label>
                    <input
                      type="number"
                      value={maxRecords}
                      onChange={handleMaxRecordsChange}
                      min="1"
                      max="50000"
                      style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <button
                  onClick={handleSearch}
                  disabled={loading}
                  style={{ 
                    padding: '8px 16px', 
                    borderRadius: 4, 
                    border: 'none', 
                    background: loading ? '#aaa' : '#4945FF', 
                    color: 'white',
                    cursor: loading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {loading ? 'Searching...' : 'Search Records'}
                </button>
              </div>
            </div>
            
            {/* Results section */}
            {searchPerformed && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h3 style={{ margin: 0 }}>Results ({records.length} records found)</h3>
                  <div>
                    <label style={{ marginRight: 8 }}>
                      <input 
                        type="checkbox" 
                        checked={records.length > 0 && records.every(record => selectedRecords.includes(record.id))}
                        onChange={selectAllOnPage}
                      />
                      {records.length > 0 && records.every(record => selectedRecords.includes(record.id)) 
                        ? 'Deselect All' 
                        : 'Select All'}
                    </label>
                  </div>
                </div>

                {records.length > 0 ? (
                  <div>
                    {/* Records table */}
                    <div style={{ overflowX: 'auto', maxHeight: '400px', border: '1px solid #eee' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f5f5f5' }}>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}></th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>URL</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>Publisher</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>Email</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>Price</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>DR</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>DA</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>Category</th>
                            <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #ddd' }}>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.map(record => (
                            <tr key={record.id} style={{ borderBottom: '1px solid #eee' }}>
                              <td style={{ padding: 8 }}>
                                <input 
                                  type="checkbox" 
                                  checked={selectedRecords.includes(record.id)}
                                  onChange={() => toggleRecordSelection(record.id)}
                                />
                              </td>
                              <td style={{ padding: 8 }}>
                                <div style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {record.url || record.attributes?.url || 'N/A'}
                                </div>
                              </td>
                              <td style={{ padding: 8 }}>{record.publisher_name || record.attributes?.publisher_name || 'N/A'}</td>
                              <td style={{ padding: 8 }}>{record.publisher_email || record.attributes?.publisher_email || 'N/A'}</td>
                              <td style={{ padding: 8 }}>${record.price || record.attributes?.price || 'N/A'}</td>
                              <td style={{ padding: 8 }}>{record.ahrefs_dr || record.attributes?.ahrefs_dr || 'N/A'}</td>
                              <td style={{ padding: 8 }}>{record.moz_da || record.attributes?.moz_da || 'N/A'}</td>
                              <td style={{ padding: 8 }}>
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
                              <td style={{ padding: 8 }}>{record.backlink_type || record.attributes?.backlink_type || 'N/A'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    {pageCount > 1 && (
                      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16, gap: 8 }}>
                        <button 
                          onClick={() => loadPage(currentPage - 1)}
                          disabled={currentPage === 1 || loading}
                          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd' }}
                        >
                          Previous
                        </button>
                        <span style={{ padding: '4px 8px' }}>Page {currentPage} of {pageCount}</span>
                        <button 
                          onClick={() => loadPage(currentPage + 1)}
                          disabled={currentPage === pageCount || loading}
                          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd' }}
                        >
                          Next
                        </button>
                      </div>
                    )}

                    {/* Selected count */}
                    <div style={{ marginTop: 16, padding: 12, background: '#f0f8ff', borderRadius: 4 }}>
                      <strong>{selectedRecords.length} records selected</strong>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 16, background: '#f5f5f5', borderRadius: 4, textAlign: 'center' }}>
                    No records found matching your filter criteria
                  </div>
                )}
              </div>
            )}
            
            {/* Error display */}
            {error && (
              <div style={{ padding: 12, background: '#fee', color: '#c00', borderRadius: 4, marginBottom: 16 }}>
                {error}
              </div>
            )}
            
            {/* Action buttons */}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                {searchPerformed && records.length > 0 && (
                  <button
                    onClick={handleExportSelected}
                    disabled={loading || selectedRecords.length === 0}
                    style={{ 
                      padding: '8px 16px', 
                      borderRadius: 4, 
                      border: 'none', 
                      background: loading || selectedRecords.length === 0 ? '#aaa' : '#4CAF50', 
                      color: 'white',
                      cursor: loading || selectedRecords.length === 0 ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {loading ? 'Processing...' : `Export Selected (${selectedRecords.length})`}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button 
                  onClick={() => setIsVisible(false)} 
                  style={{ padding: '8px 16px', borderRadius: 4, border: '1px solid #ddd', background: '#f5f5f5' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkExport}
                  disabled={loading || records.length === 0}
                  style={{ 
                    padding: '8px 16px', 
                    borderRadius: 4, 
                    border: 'none', 
                    background: loading || records.length === 0 ? '#aaa' : '#4945FF', 
                    color: 'white',
                    cursor: loading || records.length === 0 ? 'not-allowed' : 'pointer'
                  }}
                >
                  {loading ? 'Processing...' : `Export All (${records.length})`}
                </button>
              </div>
            </div>
          </div>
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
