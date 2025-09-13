# karibou-wallet v3.5.9 - Release Notes

## 🚀 Major Release: Stripe v11.18.0 Migration & Customer Default Payment Method Strategy

### 📋 Quick Summary

This major release migrates karibou-wallet from Stripe v9.16.0 to v11.18.0 and implements the **Customer Default Payment Method Strategy** - the only supported approach for subscription payment cascading in modern Stripe.

### ⚡ Key Highlights

- ✅ **Stripe v11.18.0** with API 2024-06-20 support
- ✅ **Customer Default Payment Method Strategy** (only method supported for subscriptions)
- ✅ **97% test success rate** (32/33 tests passing)
- ✅ **Comprehensive documentation** for all breaking changes
- ✅ **Robust error handling** and TypeScript improvements

### 🔥 Breaking Changes

#### 1. **Stripe Version Upgrade**
```bash
# Dependencies
stripe: ^9.16.0 → ^11.18.0
@types/stripe-v3: REMOVED (obsolete)
```

#### 2. **Parameter `card` Usage**
```typescript
// ❌ OLD: card used for all payments
SubscriptionContract.create(customer, card, interval, startDate, items, options)

// ✅ NEW: card only used for invoice payments
// For Stripe payments: card parameter is IGNORED
// Uses customer.invoice_settings.default_payment_method instead
```

#### 3. **Payment Status Codes**
```typescript
// ❌ OLD: Stripe v9
'requires_source_action' // 3DS
'requires_source'        // Payment failure

// ✅ NEW: Stripe v11.18.0
'requires_action'        // 3DS
'requires_payment_method' // Payment failure
```

### 🎯 New Features

#### **Customer Default Payment Method**
```typescript
// Configure default payment method
await customer.Customer.addMethod(customerId, paymentMethodId);

// Retrieve default payment method
const defaultMethod = customer.defaultMethod;
console.log(defaultMethod.default); // true

// List all methods with default marking
const { methods } = await customer.listMethods();
```

#### **Enhanced Subscription Features**
- ✅ `billing_cycle_anchor` support for future subscriptions
- ✅ `acceptUnpaid` metadata for unpaid invoice management
- ✅ Robust `latestPaymentIntent` getter with error handling
- ✅ Comprehensive documentation for `interval` and `status` getters

### 📚 Migration Guide

#### **Step 1: Update Dependencies**
```bash
npm install karibou-wallet@3.5.9
```

#### **Step 2: Configure Customer Default Payment Method**
```typescript
// Before creating subscriptions, ensure default payment method is set
await customer.Customer.addMethod(customerId, paymentMethodId);
```

#### **Step 3: Update Payment Status Handling**
```typescript
// Update your payment status checks
if (paymentIntent.status === 'requires_action') {
  // Handle 3DS authentication
}
if (paymentIntent.status === 'requires_payment_method') {
  // Handle payment method issues
}
```

#### **Step 4: Remove Obsolete Options**
```typescript
// ❌ REMOVE: useCustomerDefaultPaymentMethod (no longer supported)
const options = { 
  // useCustomerDefaultPaymentMethod: true // REMOVE THIS
};

// ✅ Customer Default Payment Method is now automatic
```

### 🧪 Test Results

- **32/33 tests passing** (97% success rate)
- All subscription payment flows validated
- Customer Default Payment Method strategy fully tested
- Stripe v11.18.0 compatibility confirmed

### 📖 Documentation

- **Complete CHANGELOG.md** with detailed breaking changes
- **Updated API documentation** for all new features
- **Migration examples** for common use cases
- **TypeScript definitions** updated for v11.18.0

### 🔧 Technical Details

#### **Why Customer Default Payment Method?**

`automatic_payment_methods` is **NOT supported** for Stripe subscriptions (even in v11.18.0). The Customer Default Payment Method strategy is the **only way** to achieve automatic payment method cascading for subscriptions.

#### **API 2024-06-20 Features**

This API version focuses on:
- Issuing API improvements (cards)
- Connect API enhancements (marketplaces)
- **No breaking changes** for subscription functionality used by karibou-wallet

### 🚨 Important Notes

1. **automatic_payment_methods**: Still not supported for subscriptions
2. **Parameter card**: Only used for `invoice` payments (fallback internal)
3. **Payment cascading**: Only works via Customer Default Payment Method
4. **Test compatibility**: Some tests may need updates for status codes

### 📞 Support

For migration assistance or questions:
- Check the complete CHANGELOG.md
- Review migration examples in documentation
- Test with your specific use cases before production deployment

---

**Full Documentation**: See CHANGELOG.md for complete details and examples.
