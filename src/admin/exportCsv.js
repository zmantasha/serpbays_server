import axios from 'axios';

export async function exportMarketplaceCsv(selectedIds) {
  // Call your Strapi backend API to fetch the selected marketplace entries
  // and return a CSV file for download.
  // This assumes you have a backend route like /api/marketplaces/export-csv
  const response = await axios.post('/api/marketplaces/export-csv', { ids: selectedIds }, {
    responseType: 'blob', // Important for downloading files
  });

  // Create a blob from the response and trigger download
  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'marketplace_export.csv');
  document.body.appendChild(link);
  link.click();
  link.parentNode.removeChild(link);
}
