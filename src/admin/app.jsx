import React, { useState } from 'react';
import axios from 'axios';

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

      const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile && selectedFile.type === 'text/csv') {
          setFile(selectedFile);
          setError(null);
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
              // Refresh the list view
              window.location.reload();
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
                <li>link_insertion_price</li>
                <li>TAT</li>
                <li>min_word_count</li>
                <li>forbidden_gp_price</li>
                <li>forbidden_li_price</li>
                <li>sample_post</li>
                <li>backlink_type (Do follow/No follow)</li>
                <li>category (JSON array)</li>
                <li>other_category (JSON array)</li>
                <li>guidelines</li>
                <li>backlink_validity</li>
                <li>ahrefs_dr</li>
                <li>ahrefs_traffic</li>
                <li>ahrefs_rank</li>
                <li>moz_da</li>
                <li>fast_placement_status (true/false)</li>
                <li>publisher_name (required)</li>
                <li>publisher_email (required)</li>
                <li>publisher_price</li>
                <li>publisher_forbidden_gp_price</li>
                <li>publisher_forbidden_li_price</li>
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
