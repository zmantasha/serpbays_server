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
    // const ImportModal = ({ setIsVisible }) => {
    //   const [file, setFile] = useState(null);
    //   const [isUploading, setIsUploading] = useState(false);
    //   const [error, setError] = useState(null);
    //   const [duplicates, setDuplicates] = useState(null);
    //   const [createdCount, setCreatedCount] = useState(0);
    //   const [selectedDuplicates, setSelectedDuplicates] = useState([]);

    //   const validateCSVHeaders = async (file) => {
    //     return new Promise((resolve, reject) => {
    //       const reader = new FileReader();
    //       reader.onload = (event) => {
    //         try {
    //           // Get first line and parse headers
    //           const firstLine = event.target.result.toString().split('\n')[0];
    //           const headers = firstLine.split(',').map(h => h.trim().toLowerCase());
              
    //           // Check for missing required fields
    //           const missingFields = MISSING_FIELDS.filter(field => !headers.includes(field));
    //           const requiredFields = REQUIRED_FIELDS.filter(field => !headers.includes(field));
              
    //           if (missingFields.length > 0) {
    //             reject(`Missing required fields: ${missingFields.join(', ')}`);
    //           } else if(requiredFields.length > 0) {
    //             reject(`Required fields are: ${REQUIRED_FIELDS.join(', ')}`);
    //           } else {
    //             resolve(true);
    //           }
    //         } catch (error) {
    //           reject('Error reading CSV headers');
    //         }
    //       };
    //       reader.onerror = () => reject('Error reading file');
    //       reader.readAsText(file);
    //     });
    //   };

    //   const handleFileChange = async (e) => {
    //     const selectedFile = e.target.files[0];
    //     if (selectedFile && selectedFile.type === 'text/csv') {
    //       try {
    //         await validateCSVHeaders(selectedFile);
    //         setFile(selectedFile);
    //         setError(null);
    //       } catch (error) {
    //         setError(error);
    //         setFile(null);
    //       }
    //     } else {
    //       setError('Please select a valid CSV file');
    //       setFile(null);
    //     }
    //   };

    //   const handleDuplicateToggle = (url) => {
    //     setSelectedDuplicates(prev => {
    //       if (prev.includes(url)) {
    //         return prev.filter(item => item !== url);
    //       } else {
    //         return [...prev, url];
    //       }
    //     });
    //   };

    //   const handleDownloadDuplicates = () => {
    //     if (!duplicates || !duplicates.duplicates.length) return;
        
    //     // Create CSV content with more columns
    //     const headers = [
    //       'URL', 
    //       'Current Price', 
    //       'New Price', 
    //       'Current Publisher Name', 
    //       'New Publisher Name', 
    //       'Current Publisher Email', 
    //       'New Publisher Email', 
    //       'Current Publisher Price', 
    //       'New Publisher Price'
    //     ];
    //     let csvContent = headers.join(',') + '\n';
        
    //     duplicates.duplicates.forEach(dup => {
    //       const row = [
    //         `"${dup.url}"`,
    //         `"${dup.existingItem.price || ''}"`,
    //         `"${dup.newItem.price || ''}"`,
    //         `"${dup.existingItem.publisher_name || ''}"`,
    //         `"${dup.newItem.publisher_name || ''}"`,
    //         `"${dup.existingItem.publisher_email || ''}"`,
    //         `"${dup.newItem.publisher_email || ''}"`,
    //         `"${dup.existingItem.publisher_price || ''}"`,
    //         `"${dup.newItem.publisher_price || ''}"`
    //       ];
    //       csvContent += row.join(',') + '\n';
    //     });
        
    //     const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    //     const url = URL.createObjectURL(blob);
    //     const link = document.createElement('a');
    //     link.setAttribute('href', url);
    //     link.setAttribute('download', 'duplicate-items.csv');
    //     link.style.visibility = 'hidden';
    //     document.body.appendChild(link);
    //     link.click();
    //     document.body.removeChild(link);
    //   };

    //   const handleConfirmDuplicates = () => {
    //     if (!duplicates || !duplicates.duplicates.length || !selectedDuplicates.length) {
    //       return;
    //     }

    //     setIsUploading(true);
    //     setError(null);

    //     // Filter the CSVData to include only selected duplicates
    //     const updatedDuplicates = duplicates.duplicates.filter(dup => 
    //       selectedDuplicates.includes(dup.url)
    //     );
        
    //     // Create the final data for upload with confirmDuplicates array
    //     const finalData = {
    //       confirmDuplicates: selectedDuplicates,
    //     };
        
    //     // Send to the server
    //     axios.post('/api/upload-csv', finalData)
    //       .then(response => {
    //         setDuplicates(null);
    //         setSelectedDuplicates([]);
    //         setCreatedCount(response.data.created);
    //         setFile(null);
    //       })
    //       .catch(err => {
    //         console.error('Error updating items:', err);
    //         setError(err.response?.data?.message || 'Error updating items');
    //       })
    //       .finally(() => {
    //         setIsUploading(false);
    //       });
    //   };

    //   const handleUpload = async () => {
    //     if (!file) {
    //       setError('Please select a file first');
    //       return;
    //     }

    //     setIsUploading(true);
    //     setError(null);

    //     const formData = new FormData();
    //     formData.append('files', file);

    //     try {
    //       // Get auth token from localStorage
    //       const auth = JSON.parse(localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken'));
          
    //       if (!auth) {
    //         throw new Error('Authentication token not found');
    //       }

    //       // First upload the file
    //       const uploadResponse = await axios.post('/upload', formData, {
    //         headers: {
    //           'Content-Type': 'multipart/form-data',
    //           'Authorization': `Bearer ${auth}`
    //         },
    //       });

    //       if (uploadResponse.data) {
    //         // Now process the uploaded file
    //         const response = await axios.post('/api/upload-csv', {
    //           fileId: uploadResponse.data[0].id
    //         }, {
    //           headers: {
    //             'Authorization': `Bearer ${auth}`
    //           }
    //         });

    //         if (response.data) {
    //           if (response.data.needsConfirmation) {
    //             // Store duplicates for confirmation
    //             setDuplicates({
    //               ...response.data,
    //               fileId: uploadResponse.data[0].id
    //             });
    //             setCreatedCount(response.data.createdCount || 0);
    //           } else if (response.data.errors && response.data.errors.length > 0) {
    //             setError(`Import completed with errors:\n${response.data.errors.join('\n')}`);
    //           } else {
    //             // Refresh the list view
    //             window.location.reload();
    //           }
    //         }
    //       }
    //     } catch (err) {
    //       console.error('Upload error:', err);
    //       const errorMessage = err.response?.data?.error?.message || err.message || 'Error uploading file';
    //       console.log('File being uploaded:', file);
    //       setError(errorMessage);
    //     } finally {
    //       setIsUploading(false);
    //     }
    //   };

    //   // Styling
    //   const primaryButtonStyle = {
    //     padding: '8px 16px',
    //     borderRadius: 4,
    //     border: 'none',
    //     background: '#4945FF',
    //     color: 'white',
    //     cursor: 'pointer'
    //   };
      
    //   const secondaryButtonStyle = {
    //     padding: '8px 16px',
    //     borderRadius: 4,
    //     border: '1px solid #ccc',
    //     background: '#f5f5f5',
    //     cursor: 'pointer'
    //   };

    //   // Render duplicate confirmation content
    //   const renderDuplicateContent = () => {
    //     if (!duplicates) return null;
        
    //     return (
    //       <>
    //         <h2>Duplicate entries found</h2>
    //         <p>The following entries already exist in the database. Select which ones you want to update:</p>
    //         <div style={{ maxHeight: 300, overflow: 'auto', marginBottom: 16 }}>
    //           <table style={{ width: '100%', borderCollapse: 'collapse' }}>
    //             <thead>
    //               <tr style={{ backgroundColor: '#f5f5f5' }}>
    //                 <th style={{ textAlign: 'left', padding: 8, border: '1px solid #ddd' }}>Select</th>
    //                 <th style={{ textAlign: 'left', padding: 8, border: '1px solid #ddd' }}>URL</th>
    //                 <th style={{ textAlign: 'left', padding: 8, border: '1px solid #ddd' }}>Current Price</th>
    //                 <th style={{ textAlign: 'left', padding: 8, border: '1px solid #ddd' }}>New Price</th>
    //                 <th style={{ textAlign: 'left', padding: 8, border: '1px solid #ddd' }}>Current Publisher</th>
    //                 <th style={{ textAlign: 'left', padding: 8, border: '1px solid #ddd' }}>New Publisher</th>
    //               </tr>
    //             </thead>
    //             <tbody>
    //               {duplicates.duplicates.map((dup, index) => (
    //                 <tr key={index}>
    //                   <td style={{ padding: 8, border: '1px solid #ddd' }}>
    //                     <input 
    //                       type="checkbox" 
    //                       checked={selectedDuplicates.includes(dup.url)}
    //                       onChange={() => handleDuplicateToggle(dup.url)}
    //                     />
    //                   </td>
    //                   <td style={{ padding: 8, border: '1px solid #ddd' }}>{dup.url}</td>
    //                   <td style={{ padding: 8, border: '1px solid #ddd' }}>{dup.existingItem.price}</td>
    //                   <td style={{ padding: 8, border: '1px solid #ddd' }}>{dup.newItem.price}</td>
    //                   <td style={{ padding: 8, border: '1px solid #ddd' }}>{dup.existingItem.publisher_name}</td>
    //                   <td style={{ padding: 8, border: '1px solid #ddd' }}>{dup.newItem.publisher_name}</td>
    //                 </tr>
    //               ))}
    //             </tbody>
    //           </table>
    //         </div>
    //         <div style={{ display: 'flex', justifyContent: 'space-between' }}>
    //           <button 
    //             onClick={handleDownloadDuplicates} 
    //             style={{ display: 'flex', alignItems: 'center', gap: 8, ...secondaryButtonStyle }}
    //           >
    //             <Download />
    //             Download Comparison
    //           </button>
    //           <div>
    //             <button 
    //               onClick={() => {
    //                 setDuplicates(null);
    //                 setSelectedDuplicates([]);
    //               }} 
    //               style={secondaryButtonStyle}
    //             >
    //               Cancel
    //             </button>
    //             <button 
    //               onClick={handleConfirmDuplicates} 
    //               style={{ ...primaryButtonStyle, marginLeft: 8 }}
    //               disabled={selectedDuplicates.length === 0}
    //             >
    //               Update Selected ({selectedDuplicates.length})
    //             </button>
    //           </div>
    //         </div>
    //       </>
    //     );
    //   };

    //   return (
    //     <>
    //       <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.2)', zIndex: 1000 }}>
    //         <div style={{ background: 'white', padding: 24, borderRadius: 8, maxWidth: 700, margin: '60px auto' }}>
    //           <h2>Import CSV</h2>
              
    //           {duplicates ? (
    //             renderDuplicateContent()
    //           ) : createdCount > 0 ? (
    //             <>
    //               <h2>Upload Successful</h2>
    //               <p>{createdCount} entries have been created/updated.</p>
    //               <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
    //                 <button 
    //                   onClick={() => {
    //                     setCreatedCount(0);
    //                     setIsVisible(false);
    //                   }} 
    //                   style={primaryButtonStyle}
    //                 >
    //                   Close
    //                 </button>
    //               </div>
    //             </>
    //           ) : (
    //             <>
    //               <div style={{ marginBottom: 16 }}>
    //                 <input 
    //                   type="file" 
    //                   accept=".csv" 
    //                   onChange={handleFileChange}
    //                   style={{ display: 'none' }}
    //                   id="csv-upload"
    //                 />
    //                 <label 
    //                   htmlFor="csv-upload" 
    //                   style={{
    //                     display: 'inline-block',
    //                     padding: '8px 16px',
    //                     borderRadius: 4,
    //                     border: '1px dashed #4945FF',
    //                     background: '#f0f0ff',
    //                     cursor: 'pointer'
    //                   }}
    //                 >
    //                   Select CSV File
    //                 </label>
    //                 {file && <span style={{ marginLeft: 8 }}>{file.name}</span>}
    //               </div>
                  
    //               {error && (
    //                 <div style={{ color: 'red', marginBottom: 16 }}>
    //                   {error}
    //                 </div>
    //               )}
                  
    //               <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
    //                 <button
    //                   onClick={() => setIsVisible(false)}
    //                   style={secondaryButtonStyle}
    //                 >
    //                   Cancel
    //                 </button>
    //                 <button
    //                   onClick={handleUpload}
    //                   disabled={!file || isUploading}
    //                   style={primaryButtonStyle}
    //                 >
    //                   {isUploading ? 'Uploading...' : 'Upload'}
    //                 </button>
    //               </div>
    //             </>
    //           )}
    //         </div>
    //       </div>
    //     </>
    //   );
    // };
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

   
    // CSV Export Component
    const ExportModal = ({ isVisible, setIsVisible }) => {
      const [filterEmail, setFilterEmail] = useState('');
      const [filterUrl, setFilterUrl] = useState('');
      const [filterCategory, setFilterCategory] = useState('');
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
        setMaxRecords(Math.min(Math.max(value, 1), 50000)); // Limit between 1 and 50000
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
          
          const res = await axios.get('/api/marketplaces/admin-list', {
            params: {
              ...filters,
              page: 1, 
              pageSize: Math.min(pageSize, maxRecords), // Respect maxRecords limit for search too
              limit: maxRecords, // Add explicit limit parameter
            },
            withCredentials: true,
          });
        console.log(res.data)
          setRecords(res.data.data || []);
          
          // Limit the total count to respect maxRecords setting
          const actualTotal = res.data.meta?.pagination?.total || 0;
          setTotalCount(Math.min(actualTotal, maxRecords));
          
          // Recalculate page count based on limited total
          const limitedTotal = Math.min(actualTotal, maxRecords);
          const calculatedPageCount = Math.ceil(limitedTotal / pageSize);
          setPageCount(calculatedPageCount);
          
          setCurrentPage(1);
          setSearchPerformed(true);
          // Clear existing selections when loading new data
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
          const offset = (page - 1) * pageSize;
          const remainingRecords = maxRecords - offset;
          const effectivePageSize = Math.min(pageSize, Math.max(0, remainingRecords));
          
          // Don't load page if we've already reached the max records limit
          if (effectivePageSize <= 0) {
            setLoading(false);
            return;
          }
          
          const res = await axios.get('/api/marketplaces/admin-list', {
            params: {
              ...filters,
              page,
              pageSize: effectivePageSize,
              limit: maxRecords,
            },
            withCredentials: true,
          });
          
          setRecords(res.data.data || []);
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
          // Get auth token from localStorage
          const token = localStorage.getItem('jwtToken') || localStorage.getItem('jwt');
          
          // Make request for CSV download with selected IDs
          const response = await axios.post('/api/marketplaces/export-selected-csv', {
            ids: selectedRecords
          }, {
            responseType: 'blob', // Important for file download
            withCredentials: true,
            headers: {
              Authorization: `Bearer ${token}`,
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
          
          // Get auth token from localStorage
          const token = localStorage.getItem('jwtToken') || localStorage.getItem('jwt');
          
          // Add limit parameter
          const params = {
            ...filters,
            limit: maxRecords,
          };
          
          // Make request for CSV download
          const response = await axios.get('/api/marketplaces/export-filtered-csv', {
            params,
            responseType: 'blob', // Important for file download
            withCredentials: true,
            headers: {
              Authorization: `Bearer ${token}`,
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
                  <h3 style={{ margin: 0 }}>Results ({totalCount} records found)</h3>
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
                  disabled={loading || totalCount === 0}
                  style={{ 
                    padding: '8px 16px', 
                    borderRadius: 4, 
                    border: 'none', 
                    background: loading || totalCount === 0 ? '#aaa' : '#4945FF', 
                    color: 'white',
                    cursor: loading || totalCount === 0 ? 'not-allowed' : 'pointer'
                  }}
                >
                  {loading ? 'Processing...' : `Export All (${totalCount})`}
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
