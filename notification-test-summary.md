# Notification System Test Summary

## 🔔 Notification Types Implemented

### **Order Notifications**
1. **New Order** (`new_order`)
   - **Trigger:** When an advertiser creates a new order
   - **Recipient:** Publisher (website owner)
   - **Location:** `order.create()` method
   - **Fixed:** ✅ Now correctly finds publisher by email from marketplace

2. **Order Accepted** (`order_accepted`)
   - **Trigger:** When a publisher accepts an order
   - **Recipient:** Advertiser
   - **Location:** `order.acceptOrder()` method
   - **Status:** ✅ Implemented

3. **Order Rejected** (`order_rejected`)
   - **Trigger:** When a publisher rejects an order
   - **Recipient:** Advertiser
   - **Location:** `order.rejectOrder()` method
   - **Status:** ✅ Implemented

4. **Order Delivered** (`order_delivered`)
   - **Trigger:** When a publisher marks order as delivered
   - **Recipient:** Advertiser
   - **Location:** `order.deliverOrder()` method
   - **Status:** ✅ Implemented

5. **Order Completed** (`order_completed`)
   - **Trigger:** When an advertiser accepts/completes an order
   - **Recipient:** Publisher
   - **Location:** `order.completeOrder()` method
   - **Status:** ✅ Implemented

### **Payment Notifications**
6. **Payment Received** (`payment_received`)
   - **Trigger:** When an order is completed and payment is released
   - **Recipient:** Publisher
   - **Location:** `order.completeOrder()` method
   - **Status:** ✅ Implemented

7. **Withdrawal Approved** (`withdrawal_approved`)
   - **Trigger:** When admin approves a withdrawal request
   - **Recipient:** Publisher
   - **Location:** `withdrawal.approveWithdrawal()` method
   - **Status:** ✅ Implemented

8. **Withdrawal Denied** (`withdrawal_denied`)
   - **Trigger:** When admin denies a withdrawal request
   - **Recipient:** Publisher
   - **Location:** `withdrawal.denyWithdrawal()` method
   - **Status:** ✅ Implemented

## 🐛 **Key Fixes Applied**

### **1. Publisher Lookup Fix**
**Problem:** Notifications weren't being created for new orders because the system was looking for a non-existent `users_permissions_user` relation on the marketplace model.

**Solution:** 
```javascript
// OLD (broken)
const website = await strapi.db.query('api::marketplace.marketplace').findOne({
  where: { id: orderData.website },
  populate: ['users_permissions_user'] // This relation doesn't exist
});

// NEW (fixed)
const website = await strapi.db.query('api::marketplace.marketplace').findOne({
  where: { id: orderData.website }
});

if (website && website.publisher_email) {
  const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
    where: { email: website.publisher_email }
  });
  // Create notification for publisherUser.id
}
```

### **2. Database Schema Fix**
**Problem:** Strapi was failing to start due to invalid relationship definition.

**Solution:** Removed `inversedBy` property from notification schema:
```json
"recipient": {
  "type": "relation",
  "relation": "manyToOne",
  "target": "plugin::users-permissions.user"
}
```

### **3. Message Content Fix**
**Problem:** Notification messages were trying to use `website.name` which doesn't exist.

**Solution:** Updated to use `website.url` and added fallbacks for user names:
```javascript
message = `You have received a new order from ${order.advertiser?.username || order.advertiser?.name || 'an advertiser'} for ${order.website?.url || 'your website'}.`
```

## 🧪 **Testing Endpoints**

### **Test Basic Notification**
```bash
POST /api/notifications/test
{
  "title": "Test Notification",
  "message": "Testing the notification system",
  "type": "system",
  "action": "system_update"
}
```

### **Test Order Notification**
```bash
POST /api/notifications/test-order
{
  "orderId": 123,
  "action": "new_order"
}
```

### **Get My Notifications**
```bash
GET /api/notifications/my
GET /api/notifications/my?type=order
GET /api/notifications/my?isRead=false
```

### **Get Unread Count**
```bash
GET /api/notifications/unread-count
```

## 🔍 **Debugging Steps**

1. **Check Server Logs:** Look for notification creation logs:
   ```
   Creating new order notification for publisher 123 (publisher@example.com)
   Notification created: 456 for user 123 - new_order
   ```

2. **Test Direct Notification Creation:**
   ```bash
   curl -X POST http://localhost:1337/api/notifications/test \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"title":"Test","message":"Testing"}'
   ```

3. **Check Database:** Verify notifications are being created:
   ```sql
   SELECT * FROM notifications WHERE recipient = USER_ID ORDER BY createdAt DESC;
   ```

4. **Test Order Flow:**
   - Create an order as advertiser
   - Check if publisher receives notification
   - Accept order as publisher
   - Check if advertiser receives notification

## 🚀 **Next Steps**

1. **Test the complete flow:**
   - Create order → Check new_order notification
   - Accept order → Check order_accepted notification
   - Deliver order → Check order_delivered notification
   - Complete order → Check order_completed + payment_received notifications

2. **Test withdrawal flow:**
   - Request withdrawal
   - Admin approve → Check withdrawal_approved notification
   - Admin deny → Check withdrawal_denied notification

3. **Frontend testing:**
   - Check notification bell shows unread count
   - Check notifications page displays correctly
   - Test mark as read functionality
   - Test notification deletion

## 📝 **Common Issues & Solutions**

### **Issue: No notifications appearing**
- Check server logs for errors
- Verify user authentication
- Test with `/api/notifications/test` endpoint
- Check database for notification records

### **Issue: Publisher not receiving new order notifications**
- Verify marketplace has correct `publisher_email`
- Check if user exists with that email
- Look for "Publisher user not found" logs

### **Issue: Notification bell not updating**
- Check browser console for API errors
- Verify JWT token is valid
- Test `/api/notifications/unread-count` endpoint directly

## ✅ **Verification Checklist**

- [ ] Server starts without errors
- [ ] Test notification endpoint works
- [ ] New order creates notification for publisher
- [ ] Order acceptance creates notification for advertiser
- [ ] Order delivery creates notification for advertiser
- [ ] Order completion creates notifications for publisher
- [ ] Withdrawal approval/denial creates notifications
- [ ] Frontend notification bell shows count
- [ ] Notifications page displays correctly
- [ ] Mark as read functionality works
- [ ] Delete notification functionality works 