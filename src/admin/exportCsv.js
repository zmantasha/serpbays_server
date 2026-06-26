import axios from 'axios';

function getAdminJwtToken() {
  try {
    const stored = localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken');
    if (stored) return JSON.parse(stored);
  } catch {/* fall through */}
  const cookie = document.cookie.split('; ').find(r => r.startsWith('jwtToken='));
  return cookie ? cookie.substring('jwtToken='.length) : null;
}

export async function exportMarketplaceCsv(selectedIds) {
  const auth = getAdminJwtToken();
  if (!auth) throw new Error('Admin auth token not found. Please log out and back in.');

  const response = await axios.post('/api/marketplaces/export-csv', { ids: selectedIds }, {
    responseType: 'blob',
    headers: { Authorization: `Bearer ${auth}` },
    withCredentials: true,
  });

  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'marketplace_export.csv');
  document.body.appendChild(link);
  link.click();
  link.parentNode.removeChild(link);
}
