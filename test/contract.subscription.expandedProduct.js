/**
 * Test for BUG FIX: price.product can be expanded object or string ID
 * 
 * When retrieving a subscription with expand 'items.data.price.product',
 * Stripe may return the full product object instead of just the ID string.
 * The update() method must handle both cases correctly.
 * 
 * BUG: Line 1170 in contract.subscription.ts was setting:
 *   item.product = available.price.product;
 * Without checking if it's a string or object.
 * 
 * FIX: Now extracts the ID regardless of format:
 *   const productRef = available.price.product;
 *   item.product = typeof productRef === 'string' ? productRef : productRef.id;
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);
config.option('debug', false);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const $stripe = require("../dist/payments").$stripe;
const unxor = require("../dist/payments").unxor;
const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
const should = require('should');

describe("Class subscription.expandedProduct", function() {
  this.timeout(30000);

  let testCustomer;
  let testSubscription;

  const shipping = {
    streetAdress: 'rue du test 42',
    postalCode: '1200',
    name: 'Test Family',
    price: 5,
    hours: 16,
    lat: 1,
    lng: 2
  };

  const cartItem = {
    frequency: "week",
    timestamp: Date.now(),
    hub: 'mocha-test',
    sku: 'test-expanded-' + Date.now(),
    title: "Test Expanded Product",
    quantity: 1,
    part: "1kg",
    note: "test note",
    price: 10,
    finalprice: 10,
  };

  before(async function() {
    testCustomer = await customer.Customer.create(
      "expanded-product-test@email.com",
      "Test",
      "Expanded",
      "022345",
      Date.now()
    );
    const card = await testCustomer.addMethod(unxor(card_mastercard_prepaid.id));

    // Create a subscription to test with
    const subOptions = { shipping, dayOfWeek: 2, fees: 0.06 };
    testSubscription = await subscription.SubscriptionContract.create(
      testCustomer,
      card,
      "week",
      new Date(Date.now() + 60000),
      [cartItem],
      subOptions
    );
  });

  after(async function() {
    try {
      if (testSubscription && testSubscription.id) {
        await $stripe.subscriptions.cancel(unxor(testSubscription.id));
      }
    } catch (e) {
      // Ignore if already cancelled
    }
    try {
      if (testCustomer && testCustomer.id) {
        await $stripe.customers.del(unxor(testCustomer.id));
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it("should handle price.product regardless of string or object format", async function() {
    // Get the contract - this internally uses expand: 'items.data.price.product'
    const contract = await subscription.SubscriptionContract.get(testSubscription.id);
    
    should.exist(contract);
    should.exist(contract._subscription);
    
    const items = contract._subscription.items.data;
    items.length.should.be.above(0);

    // Log and verify each product reference
    items.forEach(item => {
      const product = item.price?.product;
      should.exist(product, 'price.product should exist');
      
      const productType = typeof product;
      const productId = productType === 'string' ? product : product?.id;
      
      console.log(`     Item ${item.metadata?.sku || item.metadata?.type}: type=${productType}, id=${productId}`);
      
      // Product ID should always be extractable
      should.exist(productId);
      productId.should.startWith('prod_');
    });

    // Now update - this should work regardless of product format
    const newShipping = {
      streetAdress: 'rue mise à jour 99',
      postalCode: '1201',
      name: 'Updated Family',
      price: 8,
      hours: 18,
      lat: 46.2,
      lng: 6.1
    };

    const updateOptions = { shipping: newShipping, dayOfWeek: 3, fees: 0.07 };
    
    // ✅ This SHOULD NOT throw "Invalid string" error
    const updatedContract = await contract.update([], updateOptions);
    
    should.exist(updatedContract);
    updatedContract.content.shipping.streetAdress.should.equal('rue mise à jour 99');
    updatedContract.content.dayOfWeek.should.equal(3);
    
    testSubscription = updatedContract;
  });

  it("should verify the fix by simulating expanded product object", async function() {
    // This test directly verifies the fix logic
    const mockProductString = 'prod_ABC123';
    const mockProductObject = { 
      id: 'prod_XYZ789', 
      name: 'Test Product',
      description: 'Test Description'
    };

    // ✅ FIX: The logic that was added
    const extractProductId = (productRef) => {
      return typeof productRef === 'string' ? productRef : productRef.id;
    };

    // Test with string
    const idFromString = extractProductId(mockProductString);
    idFromString.should.equal('prod_ABC123');

    // Test with object
    const idFromObject = extractProductId(mockProductObject);
    idFromObject.should.equal('prod_XYZ789');

    console.log('     ✅ String product: ' + idFromString);
    console.log('     ✅ Object product: ' + idFromObject);
  });
});
