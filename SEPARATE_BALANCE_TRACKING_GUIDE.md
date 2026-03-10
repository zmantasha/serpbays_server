# Separate Balance Tracking System

## Overview

The SerpBays wallet system now implements separate balance tracking to prevent withdrawal of funds from vouchers and promo codes. This system maintains two distinct balance types while providing a unified user experience.

## Balance Types

### 1. Main Balance (`mainBalance`)
- **Source**: Direct payments via Stripe, PayPal, Razorpay
- **Withdrawable**: ✅ Yes - can be withdrawn
- **Usage**: Primary funds for purchases and withdrawals

### 2. Promo Balance (`promoBalance`)
- **Source**: Vouchers, promo codes, promotional credits
- **Withdrawable**: ❌ No - cannot be withdrawn
- **Usage**: Can only be used for purchases (not withdrawals)

### 3. Total Balance (`balance`)
- **Computed**: `mainBalance + promoBalance`
- **Display**: Shows combined balance to users
- **Purpose**: User-friendly total display

## Key Features

### Spending Priority
When making purchases, the system automatically spends funds in this order:
1. **Promo Balance First** - Use non-withdrawable funds first
2. **Main Balance Second** - Use withdrawable funds as needed

This maximizes the amount of withdrawable funds available to users.

### Withdrawal Restrictions
- Only `mainBalance` can be withdrawn
- Users receive clear error messages if they attempt to withdraw more than their main balance
- Promo credits are clearly indicated as non-withdrawable

## API Endpoints

### Get Wallet Balance
```http
GET /api/wallet/balance
```

**Response:**
```json
{
  "id": "wallet_id",
  "balance": 345.00,           // Total balance
  "mainBalance": 80.00,        // Withdrawable funds
  "promoBalance": 265.00,      // Non-withdrawable funds
  "withdrawableBalance": 80.00, // Same as mainBalance
  "escrowBalance": 0.00,
  "currency": "USD",
  "type": "unified"
}
```

### Add Promo Funds
```http
POST /api/wallet/add-promo-funds
```

**Body:**
```json
{
  "amount": 50.00,
  "promoCodeId": "welcome50",
  "description": "Welcome bonus"
}
```

### Redeem Promo Code
```http
POST /api/wallet/redeem-promo-code
```

**Body:**
```json
{
  "promoCode": "WELCOME50"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Promo code redeemed successfully",
  "data": {
    "promoCode": "WELCOME50",
    "amount": 50.00,
    "newPromoBalance": 315.00,
    "newTotalBalance": 395.00
  }
}
```

## Database Schema Changes

### User Wallet Table
```sql
ALTER TABLE user_wallets ADD COLUMN main_balance DECIMAL(10,2) DEFAULT 0 NOT NULL;
ALTER TABLE user_wallets ADD COLUMN promo_balance DECIMAL(10,2) DEFAULT 0 NOT NULL;
```

### Transaction Table
```sql
ALTER TABLE transactions ADD COLUMN promo_code_id VARCHAR(255) NULL;
ALTER TABLE transactions ADD COLUMN fund_source ENUM('main_fund', 'promo_fund') NULL;
```

## Migration

### Running the Migration
```bash
cd serpbays_server
npm run strapi migrate
```

### Migration Details
The migration script will:
1. Add new columns to existing tables
2. Migrate current `balance` to `main_balance` (assumes all existing funds are withdrawable)
3. Set `promo_balance` to 0 for existing wallets
4. Update existing transactions with appropriate `fund_source` values

## Business Logic

### Adding Funds

#### Direct Payments (Main Balance)
```javascript
await strapi.controller('api::user-wallet.user-wallet').addMainFunds(
  userId,
  amount,
  { gateway: 'stripe', gatewayTransactionId: 'tx_123' }
);
```

#### Promo Codes (Promo Balance)
```javascript
await strapi.controller('api::user-wallet.user-wallet').addPromoFunds(
  userId,
  amount,
  promoCodeId,
  { description: 'Welcome bonus' }
);
```

### Spending Funds
```javascript
const result = await strapi.controller('api::user-wallet.user-wallet').spendFunds(
  userId,
  amount,
  orderId,
  { description: 'Order payment' }
);

// Result includes breakdown:
// {
//   success: true,
//   promoSpent: 50.00,    // Amount spent from promo balance
//   mainSpent: 25.00,     // Amount spent from main balance
//   newPromoBalance: 215.00,
//   newMainBalance: 55.00,
//   newTotalBalance: 270.00
// }
```

### Withdrawal Validation
```javascript
const validation = await strapi.controller('api::user-wallet.user-wallet').validateWithdrawal(
  userId,
  amount
);

if (!validation.valid) {
  // Handle insufficient withdrawable funds
  console.log(validation.error); // "Insufficient withdrawable funds"
  console.log(validation.available); // 80.00
  console.log(validation.requested); // 100.00
}
```

## Frontend Integration

### Wallet Display
```typescript
interface WalletBalance {
  totalBalance: number;        // Show as main balance
  mainBalance: number;         // Show as withdrawable
  promoBalance: number;        // Show as promo credits
  withdrawableBalance: number; // Same as mainBalance
  escrowBalance: number;
}
```

### Withdrawal Form
```typescript
// Only allow withdrawals up to mainBalance
const maxWithdrawable = walletData.withdrawableBalance;

// Show clear messaging
if (requestedAmount > maxWithdrawable) {
  showError(`Cannot withdraw ${requestedAmount}. Available for withdrawal: ${maxWithdrawable}. Promo credits (${walletData.promoBalance}) cannot be withdrawn.`);
}
```

### Transaction History
Transactions now include `fund_source` to show whether funds came from:
- `main_fund` - Direct payments, earnings, refunds
- `promo_fund` - Promo codes, vouchers

## Testing

### Test Promo Codes
The system includes example promo codes for testing:
- `WELCOME50` - $50 credit
- `SAVE20` - $20 credit  
- `BONUS100` - $100 credit

### Test Scenarios
1. **Add promo funds** → Verify `promoBalance` increases, `mainBalance` unchanged
2. **Make purchase** → Verify promo funds spent first, then main funds
3. **Attempt withdrawal** → Verify only `mainBalance` can be withdrawn
4. **Check transaction history** → Verify `fund_source` is correctly set

## Security Considerations

1. **Promo Code Validation**: Implement proper validation to prevent duplicate redemptions
2. **Audit Trail**: All transactions include source tracking for compliance
3. **Balance Integrity**: Total balance always equals main + promo balance
4. **Withdrawal Protection**: Multiple validation layers prevent unauthorized withdrawals

## Error Handling

### Common Error Messages
- `"Insufficient withdrawable funds"` - Trying to withdraw more than main balance
- `"Invalid promo code"` - Promo code doesn't exist or expired
- `"Promo code already used"` - User has already redeemed this code
- `"Insufficient funds"` - Total balance insufficient for purchase

## Future Enhancements

1. **Expiring Promo Credits**: Add expiration dates to promo balances
2. **Partial Withdrawals**: Allow mixed balance withdrawals with proper tracking
3. **Promo Code Management**: Admin interface for creating/managing promo codes
4. **Balance Analytics**: Detailed reporting on balance types and usage

## Support

For issues or questions about the separate balance tracking system:
1. Check transaction logs for fund source tracking
2. Verify balance calculations in database
3. Test with example promo codes
4. Review withdrawal validation logic

This system ensures that promotional funds cannot be withdrawn while maintaining a seamless user experience for legitimate transactions.
