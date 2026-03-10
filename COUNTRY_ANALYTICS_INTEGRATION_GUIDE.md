# Country Analytics Integration Guide

This guide shows you how to add country analytics to your marketplace, similar to the functionality shown in your image.

## What Was Created

### Backend Files
1. **`serpbays_server/src/api/marketplace/controllers/country-analytics.js`** - API controller that aggregates website counts by country
2. **Updated `serpbays_server/src/api/marketplace/routes/marketplace.js`** - Added route for country analytics endpoint

### Frontend Files
1. **`serpbays_client/components/marketplace/CountryAnalytics.tsx`** - Main component displaying country cards with flags and counts
2. **`serpbays_client/components/marketplace/MarketplaceWithAnalytics.tsx`** - Wrapper component with toggle between table and analytics views
3. **`serpbays_client/lib/api/country-analytics.ts`** - API client functions
4. **`serpbays_client/app/(dashboard)/marketplace/analytics/page.tsx`** - Standalone analytics page

## Integration Options

### Option 1: Simple Integration (Recommended)
Modify your existing `marketplace/page.tsx` to add a toggle button:

```tsx
// Add to your existing marketplace page
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { BarChart3, List } from 'lucide-react'
import CountryAnalytics from '@/components/marketplace/CountryAnalytics'

// Add to your component state
const [viewMode, setViewMode] = useState<'table' | 'analytics'>('table')

// Add this function to handle country filtering
const handleCountryFilter = (country: string) => {
  setViewMode('table') // Switch back to table view
  const newFilters = { ...filters, country: [country] }
  setFilters(newFilters)
  setFilterValues(newFilters)
  setCurrentPage(1)
}

// Add view toggle buttons to your header
<div className="flex items-center gap-2">
  <Button
    variant={viewMode === 'table' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setViewMode('table')}
    className="flex items-center gap-2"
  >
    <List className="h-4 w-4" />
    Website List
  </Button>
  
  <Button
    variant={viewMode === 'analytics' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setViewMode('analytics')}
    className="flex items-center gap-2"
  >
    <BarChart3 className="h-4 w-4" />
    Country Analytics
  </Button>
</div>

// Replace your main content area with conditional rendering
{viewMode === 'analytics' ? (
  <CountryAnalytics onCountryFilter={handleCountryFilter} />
) : (
  // Your existing marketplace table/grid content
)}
```

### Option 2: Full Wrapper Integration
Use the complete `MarketplaceWithAnalytics` wrapper:

```tsx
import MarketplaceWithAnalytics from '@/components/marketplace/MarketplaceWithAnalytics'

// In your marketplace component
const handleCountryFilter = (country: string) => {
  const newFilters = { ...filters, country: [country] }
  setFilters(newFilters)
  setFilterValues(newFilters)
  setCurrentPage(1)
}

return (
  <MarketplaceWithAnalytics 
    onCountryFilter={handleCountryFilter}
    currentFilters={filters}
  >
    {/* Your existing marketplace content */}
  </MarketplaceWithAnalytics>
)
```

### Option 3: Standalone Page
The analytics are already available as a separate page at `/marketplace/analytics`.

## API Endpoint

The new endpoint is available at: `GET /api/marketplaces/country-analytics`

Response format:
```json
{
  "data": [
    {
      "country": "United States",
      "websiteCount": 235
    },
    {
      "country": "United Kingdom", 
      "websiteCount": 156
    }
  ],
  "meta": {
    "total": 45,
    "totalWebsites": 1250
  }
}
```

## Features Included

✅ **Country Cards with Flags** - Each country displays with its flag emoji and website count  
✅ **Search Functionality** - Search through countries by name  
✅ **Sorting Options** - Sort by website count or alphabetically  
✅ **Click to Filter** - Click any country card to filter the marketplace  
✅ **Progress Bars** - Visual representation of relative website counts  
✅ **Responsive Design** - Works on all screen sizes  
✅ **Loading States** - Proper loading and error handling  
✅ **Toggle Views** - Switch between table and analytics views  

## Customization

### Adding More Country Flags
Edit the `getCountryFlag` function in `CountryAnalytics.tsx` to add more country mappings:

```tsx
const flagMap: Record<string, string> = {
  'Your Country': '🇫🇯', // Add your countries here
  // ... existing mappings
}
```

### Styling
The components use Tailwind CSS and can be customized by modifying the className properties.

### API Modifications
To include additional data in the country analytics (like average prices, top categories, etc.), modify the `country-analytics.js` controller.

## Next Steps

1. **Test the Backend**: Start your Strapi server and test the endpoint at `http://localhost:1337/api/marketplaces/country-analytics`

2. **Add to Your Marketplace**: Choose one of the integration options above

3. **Customize**: Add your country flags and adjust styling as needed

4. **Optional Enhancements**:
   - Add continent grouping
   - Include price ranges per country
   - Add export functionality
   - Include historical trends

## Troubleshooting

- **No data showing**: Check that your marketplace entries have valid `countries` field data
- **Missing flags**: Add country mappings to the `getCountryFlag` function
- **API errors**: Ensure the route is properly registered and the controller file exists

The implementation is designed to work with your existing marketplace without breaking any current functionality.