import React, { useState } from 'react';
import axios from 'axios';

// Required fields for CSV validation
const REQUIRED_FIELDS = [
  'url', 
  'price', 
  'publisher_name', 
  'publisher_price', 
  'publisher_email', 
  'backlink_type', 
  'category', 
  // 'other_category', 
  // 'guidelines', 
  'backlink_validity', 
  // 'ahrefs_dr', 
  // 'ahrefs_traffic', 
  // 'ahrefs_rank', 
  // 'moz_da', 
  // 'fast_placement_status', 
  // 'sample_post', 
  // 'tat', 
  'min_word_count', 
  // 'forbidden_gp_price', 
  // 'forbidden_li_price'
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
          const auth = JSON.parse(localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken'));
          
          if (!auth) {
            throw new Error('Authentication token not found');
          }

          // Send confirmation request
          const response = await axios.post('/api/upload-csv', {
            fileId: duplicates.fileId,
            confirmDuplicates: selectedDuplicates
          }, {
            headers: {
              'Authorization': `Bearer ${auth}`
            }
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
          // Get auth token from localStorage
          const auth = JSON.parse(localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken'));
          
          if (!auth) {
            throw new Error('Authentication token not found');
          }

          // First upload the file
          const uploadResponse = await axios.post('/upload', formData, {
            headers: {
              'Content-Type': 'multipart/form-data',
              'Authorization': `Bearer ${auth}`
            },
          });

          if (uploadResponse.data) {
            // Now process the uploaded file
            const response = await axios.post('/api/upload-csv', {
              fileId: uploadResponse.data[0].id
            }, {
              headers: {
                'Authorization': `Bearer ${auth}`
              }
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

      const modalStyle = {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        backgroundColor: 'white',
        padding: '2rem',
        borderRadius: '4px',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.1)',
        width: '500px',
        maxHeight: '80vh',
        overflowY: 'auto',
        zIndex: 1000
      };

      const overlayStyle = {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        zIndex: 999
      };

      const buttonStyle = {
        padding: '8px 16px',
        borderRadius: '4px',
        border: 'none',
        cursor: 'pointer',
        marginRight: '8px'
      };

      const primaryButtonStyle = {
        ...buttonStyle,
        backgroundColor: '#4945FF',
        color: 'white'
      };

      const secondaryButtonStyle = {
        ...buttonStyle,
        backgroundColor: '#F0F0FF',
        color: '#4945FF'
      };

      const modalContentStyle = {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        backgroundColor: 'white',
        padding: '20px',
        borderRadius: '5px',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.1)',
        width: '500px',
        maxHeight: '80vh',
        overflowY: 'auto',
        zIndex: 1001,
      };

            // Render duplicate confirmation content
      const renderDuplicateContent = () => {
        return (
          <>
            <h2 style={{ marginTop: 0 }}>Duplicate URLs Found</h2>
            
            <div style={{ marginBottom: '20px' }}>
              <p>We found {duplicates.duplicates.length} URLs that already exist. Select the ones you want to update:</p>
              <p>{createdCount} new records were already created.</p>
              
              <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', padding: '10px' }}>
                {duplicates.duplicates.map((dup, index) => (
                  <div key={index} style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#f9f9f9', borderRadius: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
                      <input
                        type="checkbox"
                        id={`dup-${index}`}
                        checked={selectedDuplicates.includes(dup.url)}
                        onChange={() => handleDuplicateToggle(dup.url)}
                        style={{ marginRight: '10px' }}
                      />
                      <label htmlFor={`dup-${index}`} style={{ fontWeight: 'bold' }}>{dup.url}</label>
                    </div>
                    
                    <div style={{ display: 'flex', marginLeft: '25px' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ margin: '5px 0' }}>Current Data</h4>
                        <div>Price: {dup.existingData.price}</div>
                        <div>Publisher: {dup.existingData.publisher_name || 'N/A'}</div>
                        <div>Publisher Email: {dup.existingData.publisher_email || 'N/A'}</div>
                        <div>Publisher Price: {dup.existingData.publisher_price || 'N/A'}</div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ margin: '5px 0' }}>New Data</h4>
                        <div>Price: {dup.newData.price}</div>
                        <div>Publisher: {dup.newData.publisher_name || 'N/A'}</div>
                        <div>Publisher Email: {dup.newData.publisher_email || 'N/A'}</div>
                        <div>Publisher Price: {dup.newData.publisher_price || 'N/A'}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button 
                onClick={handleDownloadDuplicates}
                style={{
                  ...secondaryButtonStyle,
                  backgroundColor: '#4CAF50',
                  marginRight: 'auto'
                }}
              >
                Download List
              </button>
              
              <div style={{ display: 'flex', gap: '8px' }}>
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
                    backgroundColor: selectedDuplicates.length > 0 ? '#4945FF' : '#ccc',
                    cursor: selectedDuplicates.length > 0 ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isUploading ? 'Updating...' : 'Update Selected'}
                </button>
              </div>
            </div>
          </>
        );
      };

      return (
        <>
          <div style={overlayStyle} onClick={() => setIsVisible(false)} />
          <div style={modalStyle}>
            <h2 style={{ marginTop: 0 }}>{duplicates ? 'Duplicate URLs Found' : 'Import from CSV'}</h2>
            
            {error && (
              <div style={{ color: '#d02b20', marginTop: '0.5rem' }}>
                {error}
              </div>
            )}
            
            {duplicates ? (
              renderDuplicateContent()
            ) : (
              <>
                <div style={{ marginBottom: '1rem' }}>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    style={{ marginBottom: '1rem' }}
                  />
                </div>
                <div style={{ marginBottom: '1.5rem' }}>
                  <h4 style={{ marginBottom: '0.5rem' }}>Required columns:</h4>
                  <ul style={{ margin: '0 0 0 1.5rem', padding: 0 }}>
                    <li>url (required)</li>
                    <li>price (required)</li>
                    <li>publisher_name (required)</li>
                    <li>publisher_email (required)</li>
                    <li>backlink_type (required)</li>
                    <li>category (required)</li>
                    <li>other_category (required)</li>
                    <li>guidelines (required)</li>
                    <li>backlink_validity (required)</li>
                    <li>ahrefs_dr (required)</li>
                    <li>ahrefs_traffic (required)</li>
                    <li>ahrefs_rank (required)</li>
                    <li>moz_da (required)</li>
                    <li>fast_placement_status (required)</li>
                    <li>sample_post (required)</li>
                    <li>tat (required)</li>
                    <li>min_word_count (required)</li>
                    <li>forbidden_gp_price (required)</li>
                    <li>forbidden_li_price (required)</li>
                  </ul>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button
                    onClick={() => setIsVisible(false)}
                    style={secondaryButtonStyle}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpload}
                    disabled={!file || isUploading}
                    style={primaryButtonStyle}
                  >
                    {isUploading ? 'Uploading...' : 'Upload'}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      );
    };

    const Injected = () => {
      const [isVisible, setIsVisible] = useState(false);

      return (
        <>
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
          {isVisible && <ImportModal setIsVisible={setIsVisible} />}
        </>
      );
    };

    if (plugin) {
      plugin.injectComponent('listView', 'actions', {
        name: 'csv-import',
        Component: Injected
      });
    }
  },
};
