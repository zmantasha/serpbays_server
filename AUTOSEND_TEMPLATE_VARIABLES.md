# AutoSend Template Variables Guide

This document lists all variables that are passed to AutoSend email templates for dynamic content.

## Order Creation Email

**Template ID:** `A-887bd8e51845ac3ea25d`  
**Subject:** New Order Received  
**Recipient:** Publisher

### Variables Passed

```javascript
{
  // Order details
  orderId: number,              // e.g., 123
  orderStatus: string,          // e.g., "created"
  orderAmount: number,          // e.g., 50.00
  orderDescription: string,     // e.g., "Guest post with dofollow backlink"
  
  // User details
  publisherName: string,        // Publisher's username or email
  advertiserName: string,       // Advertiser's username or email
  advertiserEmail: string,      // Advertiser's email address
  
  // Website details
  websiteName: string,          // e.g., "example.com"
  websiteUrl: string,           // e.g., "https://example.com"
  
  // Content details
  contentType: string,          // e.g., "Guest Post", "Sponsored Post"
  targetUrl: string,            // URL to link to
  anchorText: string,           // Anchor text for the link
  minWordCount: number,         // Minimum word count requirement
  
  // Action URLs
  acceptUrl: string,            // URL to accept order
  rejectUrl: string,            // URL to reject order
  dashboardUrl: string,         // URL to orders dashboard
  
  // Timestamp
  orderDate: string             // e.g., "February 2, 2026"
}
```

### Usage in AutoSend Template

In your AutoSend template, you can reference these variables using the template syntax. For example:

```html
<h1>New Order #{{orderId}}</h1>
<p>Hello {{publisherName}},</p>
<p>You have received a new order from {{advertiserName}} for {{websiteName}}.</p>
<p>Order Amount: ${{orderAmount}}</p>
<a href="{{acceptUrl}}">Accept Order</a>
<a href="{{rejectUrl}}">Reject Order</a>
```

---

## Remaining Templates (To Be Implemented)

The following email types still use hardcoded HTML and need template IDs:

1. **Order Accepted** - Email sent to advertiser when publisher accepts
2. **Order Rejected** - Email sent to advertiser when publisher rejects
3. **Order Delivered** - Email sent to advertiser when publisher delivers work
4. **Order Completed** - Email sent to publisher when advertiser approves
5. **Revision Requested** - Email sent to publisher when advertiser requests revision
6. **Order Cancelled** - Email sent when either party cancels
7. **Transaction Approval** - Wallet transaction approved
8. **Transaction Denial** - Wallet transaction denied
9. **Payment Confirmation** - Payment received confirmation
10. **Withdrawal Approved** - Withdrawal request approved
11. **Withdrawal Paid** - Withdrawal paid confirmation
12. **Withdrawal Denied** - Withdrawal request denied

---

## Testing

After restarting the Strapi server, test the new order template by:

1. Create a new order in the application
2. Check the publisher's email inbox
3. Verify all variables are populated correctly
4. Test action URLs (Accept/Reject buttons)
5. Check AutoSend dashboard for delivery status

---

## Notes

- All other email types still use hardcoded HTML templates
- Template variables must match what's configured in the AutoSend template
- If a variable is undefined, it defaults to empty string or fallback value
- Client URL is pulled from `CLIENT_URL` environment variable
