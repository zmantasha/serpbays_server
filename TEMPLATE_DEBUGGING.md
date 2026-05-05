# AutoSend Template Variable Debugging

## Issue
Email template renders correctly but variables are showing empty:
- ORDER ID - empty
- TOTAL AMOUNT - empty
- CUSTOMER - empty
- ORDER DATE - empty

## Variables Currently Being Sent

```javascript
{
  orderId: order.id,
  orderAmount: order.totalAmount,
  orderDate: "February 2, 2026",
  advertiserName: "Advertiser",
  publisherName: "Publisher",
  websiteName: "example.com",
  // ... etc
}
```

## Possible Causes

1. **Variable Name Mismatch**: The template expects different variable names
   - Template might expect: `order_id` instead of `orderId`
   - Template might expect: `total_amount` instead of `orderAmount`
   - Template might expect: `customer` instead of `advertiserName`

2. **Case Sensitivity**: AutoSend might be case-sensitive

3. **Template Configuration**: Variables not configured in AutoSend template

## Action Required

**Check AutoSend Template Settings:**

1. Go to https://autosend.com/dashboard
2. Open template ID: `A-887bd8e51845ac3ea25d`
3. Look for "Variables" or "Template Variables" section
4. Note the EXACT variable names (case-sensitive)

**Common Naming Patterns:**
- Snake case: `order_id`, `total_amount`, `order_date`
- Camel case: `orderId`, `totalAmount`, `orderDate`
- Pascal case: `OrderId`, `TotalAmount`, `OrderDate`

## Next Steps

Once we know the exact variable names from AutoSend template, update:
`d:\serpbays\serpbays_server\src\api\global\services\email-operations.js` line 48-80
