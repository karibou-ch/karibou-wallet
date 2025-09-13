# Migration Guide: karibou-wallet v3.5.8 → v3.5.9

## 🚨 Critical Breaking Changes

### 1. **Stripe Version Upgrade**

**Before (v3.5.8):**
```json
{
  "stripe": "^9.16.0",
  "@types/stripe-v3": "^3.1.29"
}
```

**After (v3.5.9):**
```json
{
  "stripe": "^11.18.0"
}
```

### 2. **Parameter `card` Usage Change**

**Before (v3.5.8):**
```typescript
// card parameter was used for all payment types
const subscription = await SubscriptionContract.create(
  customer, card, interval, startDate, items, options
);
```

**After (v3.5.9):**
```typescript
// card parameter ONLY used for invoice payments
// For Stripe payments: card is IGNORED, uses customer.default_payment_method

// ✅ CORRECT: Configure default payment method first
await customer.Customer.addMethod(customerId, paymentMethodId);
const subscription = await SubscriptionContract.create(
  customer, card, interval, startDate, items, options
);
// card is ignored for Stripe payments
```

### 3. **Payment Status Codes Update**

**Before (v3.5.8) - Stripe v9:**
```typescript
if (paymentIntent.status === 'requires_source_action') {
  // Handle 3DS authentication
}
if (paymentIntent.status === 'requires_source') {
  // Handle payment failure
}
```

**After (v3.5.9) - Stripe v11.18.0:**
```typescript
if (paymentIntent.status === 'requires_action') {
  // Handle 3DS authentication
}
if (paymentIntent.status === 'requires_payment_method') {
  // Handle payment failure
}
```

### 4. **Removed Options**

**Before (v3.5.8):**
```typescript
const options = {
  useCustomerDefaultPaymentMethod: true // ❌ REMOVED
};
```

**After (v3.5.9):**
```typescript
const options = {
  // Customer Default Payment Method is now automatic
  // No need for useCustomerDefaultPaymentMethod option
};
```

## 🔄 Step-by-Step Migration

### Step 1: Update Dependencies

```bash
npm install karibou-wallet@3.5.9
```

### Step 2: Update Customer Management

**Before:**
```typescript
// Old way - no default payment method management
const customer = await Customer.create(customerData);
```

**After:**
```typescript
// New way - always configure default payment method
const customer = await Customer.create(customerData);
await customer.addMethod(customerId, paymentMethodId); // Sets default_payment_method

// Retrieve default payment method
const defaultMethod = customer.defaultMethod;
console.log(defaultMethod.default); // true
```

### Step 3: Update Subscription Creation

**Before:**
```typescript
const subscription = await SubscriptionContract.create(
  customer, card, interval, startDate, items, options
);
```

**After:**
```typescript
// Ensure default payment method is set
await customer.addMethod(customerId, paymentMethodId);

const subscription = await SubscriptionContract.create(
  customer, card, interval, startDate, items, options
);
// card parameter is ignored for Stripe payments
```

### Step 4: Update Payment Status Handling

**Before:**
```typescript
const paymentIntent = subscription.latestPaymentIntent;
if (paymentIntent.status === 'requires_source_action') {
  // Handle 3DS
}
```

**After:**
```typescript
const paymentIntent = subscription.latestPaymentIntent;
if (paymentIntent.status === 'requires_action') {
  // Handle 3DS
}
```

### Step 5: Update Tests

**Before:**
```javascript
// Old test assertions
paymentIntent.status.should.equal('requires_source_action');
paymentIntent.status.should.equal('requires_source');
```

**After:**
```javascript
// New test assertions
paymentIntent.status.should.equal('requires_action');
paymentIntent.status.should.equal('requires_payment_method');
```

## 🧪 Testing Your Migration

### 1. **Test Customer Default Payment Method**

```typescript
// Test that default payment method is correctly set
const customer = await Customer.get(customerId);
const defaultMethod = customer.defaultMethod;
assert(defaultMethod.default === true);
assert(defaultMethod.id === expectedPaymentMethodId);
```

### 2. **Test Subscription Creation**

```typescript
// Test that subscription uses customer default payment method
await customer.addMethod(customerId, paymentMethodId);
const subscription = await SubscriptionContract.create(
  customer, card, interval, startDate, items, options
);
// Verify subscription is active (not incomplete)
assert(subscription.status === 'active');
```

### 3. **Test Payment Status Handling**

```typescript
// Test new payment status codes
const paymentIntent = subscription.latestPaymentIntent;
if (paymentIntent.status === 'requires_action') {
  // Test 3DS flow
}
if (paymentIntent.status === 'requires_payment_method') {
  // Test payment method failure handling
}
```

## 🔍 Common Migration Issues

### Issue 1: Subscriptions Still `incomplete`

**Problem:**
```typescript
const subscription = await SubscriptionContract.create(...);
console.log(subscription.status); // 'incomplete'
```

**Solution:**
```typescript
// Ensure customer has default payment method set
await customer.addMethod(customerId, paymentMethodId);
const subscription = await SubscriptionContract.create(...);
```

### Issue 2: Payment Status Assertions Failing

**Problem:**
```typescript
// Old assertions failing
paymentIntent.status.should.equal('requires_source_action'); // FAILS
```

**Solution:**
```typescript
// Update to new status codes
paymentIntent.status.should.equal('requires_action'); // WORKS
```

### Issue 3: `card` Parameter Not Working

**Problem:**
```typescript
// Expecting card to be used, but it's ignored
const subscription = await SubscriptionContract.create(customer, card, ...);
```

**Solution:**
```typescript
// For Stripe payments, configure customer default payment method instead
await customer.addMethod(customerId, card.paymentMethodId);
const subscription = await SubscriptionContract.create(customer, card, ...);
```

## ✅ Migration Checklist

- [ ] Update `karibou-wallet` to v3.5.9
- [ ] Remove `@types/stripe-v3` dependency
- [ ] Update payment status code handling (`requires_source_action` → `requires_action`)
- [ ] Configure Customer Default Payment Method before subscription creation
- [ ] Remove `useCustomerDefaultPaymentMethod` option usage
- [ ] Update test assertions for new payment status codes
- [ ] Test subscription creation with Customer Default Payment Method
- [ ] Verify payment cascading works correctly
- [ ] Test 3DS flow with new status codes
- [ ] Test payment failure handling with new status codes

## 🆘 Need Help?

1. **Check the full CHANGELOG.md** for detailed changes
2. **Review RELEASE_NOTES_v3.5.9.md** for quick overview
3. **Run the test suite** to verify your migration
4. **Test with staging environment** before production

---

**Remember**: The Customer Default Payment Method strategy is now the **only supported method** for subscription payment cascading in Stripe v11.18.0+.
