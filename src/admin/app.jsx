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
              if (response.data.errors && response.data.errors.length > 0) {
                setError(`Import completed with errors:\\n${response.data.errors.join('\\n')}`);
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

      return (
        <>
          <div style={overlayStyle} onClick={() => setIsVisible(false)} />
          <div style={modalStyle}>
            <h2 style={{ marginTop: 0 }}>Import from CSV</h2>
            <div style={{ marginBottom: '1rem' }}>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                style={{ marginBottom: '1rem' }}
              />
              {error && (
                <div style={{ color: '#d02b20', marginTop: '0.5rem' }}>
                  {error}
                </div>
              )}
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
