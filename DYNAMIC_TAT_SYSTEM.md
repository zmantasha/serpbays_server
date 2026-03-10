# Dynamic TAT (Turn Around Time) System

## Overview

The Dynamic TAT System automatically updates marketplace website TAT values based on actual order completion times. This provides more accurate and responsive TAT data that reflects real performance rather than static estimates.

## How It Works

### Automatic Updates
- **Order Completion Trigger**: When an order is completed, the system automatically updates the TAT for that website based on historical completion data
- **Daily Cron Job**: Runs every day at 2 AM to update TAT for all websites with sufficient order history
- **Weekly Analysis**: Runs comprehensive TAT analysis every Sunday at 3 AM with extended lookback period

### Calculation Method
1. **Data Collection**: Gathers completed orders for each website within a specified lookback period (default: 90 days)
2. **TAT Calculation**: Calculates the time difference between order creation and completion dates
3. **Weighted Average**: Uses weighted average where more recent orders have higher impact on the final TAT
4. **Placement Speed**: Automatically updates placement speed categories based on the new TAT:
   - **Ultra Fast**: 0-2 days
   - **Fast**: 3-5 days  
   - **Normal**: 6-8 days
   - **Slow**: 9-20+ days

## Configuration Options

### Default Settings
```javascript
{
  lookbackDays: 90,           // How far back to look for orders
  minOrderCount: 3,           // Minimum orders needed for calculation
  useWeightedAverage: true,   // Whether to weight recent orders more heavily
  batchSize: 10,              // Orders to process in each batch
  delayBetweenBatches: 1000   // Delay between batches (milliseconds)
}
```

### Customizable Parameters
- **lookbackDays**: Number of days to look back for order history (30-365 days recommended)
- **minOrderCount**: Minimum completed orders required for reliable TAT calculation (2-10 recommended)
- **useWeightedAverage**: Whether recent orders should have more influence on the TAT
- **batchSize**: Number of websites to process simultaneously in bulk updates
- **delayBetweenBatches**: Delay between processing batches to prevent system overload

## API Endpoints

### Update TAT for Specific Website
```http
PUT /api/marketplaces/:id/update-tat?minOrderCount=3&lookbackDays=90&useWeightedAverage=true
```

**Authorization**: 
- Advertisers: Can update any website
- Publishers: Can only update their own websites

**Response**:
```json
{
  "message": "TAT updated successfully",
  "websiteId": 123,
  "url": "example.com",
  "previousTAT": 7,
  "newTAT": 5,
  "placementSpeed": "Fast",
  "ordersAnalyzed": 15,
  "tatValues": [3, 4, 5, 6, 7]
}
```

### Bulk Update TAT (Admin Only)
```http
POST /api/marketplaces/bulk-update-tat?batchSize=10&minOrderCount=3&lookbackDays=90
```

**Authorization**: Admin only

**Response**:
```json
{
  "message": "Bulk TAT update completed",
  "totalProcessed": 45,
  "updated": 32,
  "errors": 2,
  "unchanged": 11,
  "details": [...]
}
```

## Cron Jobs

### Daily TAT Update (2 AM)
- Updates TAT for websites with recent order activity
- Conservative settings to ensure reliable updates
- Logs errors for review

### Weekly Analysis (Sunday 3 AM)  
- Comprehensive analysis with longer lookback period
- Lower minimum order threshold for broader coverage
- Generates summary reports for performance monitoring

### Configuration
Cron jobs can be enabled/disabled via environment variable:
```bash
CRON_ENABLED=true  # Default: true
```

## Testing

### Manual Testing Script
Test the TAT update functionality:

```bash
# Test specific website
node scripts/test-tat-update.js 123

# Test bulk update
node scripts/test-tat-update.js
```

### Test Output Example
```
Testing TAT update for website ID: 123
Website: techcrunch.com
Current TAT: 7 days
Current Placement Speed: Normal
Completed orders found: 12

Updating TAT...

✅ TAT Update Results:
Previous TAT: 7 days
New TAT: 5 days
Placement Speed: Fast
Orders analyzed: 12
TAT values: [3, 4, 5, 6, 7, 4, 5, 6, 3, 5, 6, 4] days
```

## Benefits

### For Publishers
- **Accurate Performance Metrics**: TAT reflects actual delivery performance
- **Improved Marketplace Position**: Faster delivery times improve placement speed category
- **Real-time Adjustments**: TAT updates automatically as performance improves

### For Advertisers  
- **Reliable Estimates**: TAT based on real completion data, not estimates
- **Better Planning**: More accurate delivery expectations for campaigns
- **Quality Indicators**: Placement speed categories help identify reliable publishers

### For Platform
- **Data Accuracy**: Marketplace data stays current and reliable
- **Quality Control**: Identifies websites with consistently slow delivery
- **Performance Insights**: Historical data provides valuable marketplace analytics

## Implementation Details

### Database Schema
The system uses existing order fields:
- `orderDate`: When the order was created
- `completedDate`: When the order was completed
- `orderStatus`: Must be 'completed' for TAT calculation

### Performance Considerations
- **Batch Processing**: Updates processed in batches to prevent system overload
- **Background Updates**: TAT updates run asynchronously to avoid blocking order completion
- **Caching**: Results are cached in the marketplace table for fast access
- **Rate Limiting**: Delays between batches prevent overwhelming the database

### Error Handling
- **Graceful Degradation**: TAT update failures don't affect order completion
- **Logging**: All errors are logged for troubleshooting
- **Fallback**: Manual updates available via API endpoints
- **Validation**: Input validation prevents invalid TAT calculations

## Monitoring

### Log Messages
- **Daily Updates**: Summary of websites updated and any errors
- **Weekly Analysis**: Comprehensive performance reports
- **Error Tracking**: Detailed error logs for troubleshooting

### Key Metrics to Monitor
- Number of websites with updated TAT
- Distribution of placement speed categories
- Websites with consistently slow or fast TAT
- Error rates in TAT calculations

## Troubleshooting

### Common Issues

1. **Insufficient Order History**
   - **Problem**: Website has fewer completed orders than `minOrderCount`
   - **Solution**: Lower the `minOrderCount` threshold or wait for more orders

2. **No Completed Orders**
   - **Problem**: Website has no orders with `completedDate` set
   - **Solution**: Ensure orders are properly completed in the system

3. **Negative TAT Values**
   - **Problem**: Completion date is before order date
   - **Solution**: Check data integrity; system automatically handles this with `Math.max(0, tatDays)`

4. **Cron Jobs Not Running**
   - **Problem**: Scheduled updates not executing
   - **Solution**: Check `CRON_ENABLED` environment variable and server logs

### Manual Intervention
If automatic updates fail, administrators can:
1. Use the API endpoints to manually trigger updates
2. Run the test script to diagnose issues
3. Check order data integrity in the database
4. Adjust configuration parameters as needed

## Future Enhancements

### Planned Features
- **TAT Trends**: Track TAT changes over time
- **Performance Alerts**: Notify when TAT degrades significantly
- **Seasonal Adjustments**: Account for seasonal delivery variations
- **Publisher Dashboard**: Show TAT history and trends to publishers
- **Predictive TAT**: Use machine learning to predict future TAT based on order volume

### Integration Opportunities
- **Order Management**: Alert system when TAT exceeds expected delivery time
- **Publisher Analytics**: Include TAT trends in publisher performance reports
- **Marketplace Filtering**: Allow advertisers to filter by recent TAT performance
- **Automated Pricing**: Adjust pricing based on delivery speed performance 