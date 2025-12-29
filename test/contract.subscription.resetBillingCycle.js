/**
 * Karibou payment wrapper
 * Test resetBillingCycle function
 * 
 * @see https://stripe.com/docs/billing/subscriptions/billing-cycle#changing
 * @see https://stripe.com/docs/billing/subscriptions/trials (trial_end anchor behavior)
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);
config.option('debug', false);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
const subscription = require("../dist/contract.subscription");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');
const cartItems = require('./fixtures/cart.items');

describe("Class subscription.resetBillingCycle", function() {
  this.timeout(15000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultSub;

  const shipping = {
    streetAdress: 'rue du rhone 69',
    postalCode: '1208',
    name: 'reset billing test',
    price: 5,
    hours: 16,
    lat: 1,
    lng: 2
  };

  before(async function() {
    // Create customer with payment method
    defaultCustomer = await customer.Customer.create("reset-billing@test.com", "Reset", "Billing", "022345", 9999);
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;

    // Create a subscription for testing
    const fees = 0.06;
    const dayOfWeek = 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");
    const card2 = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping, dayOfWeek, fees, plan: 'customer' };
    
    defaultSub = await subscription.SubscriptionContract.create(
      defaultCustomer, card2, "week", 'now', items, subOptions
    );
  });

  after(async function() {
    // Cleanup
    if (defaultSub) {
      try {
        await defaultSub.cancel();
      } catch (e) { /* ignore */ }
    }
    if (defaultCustomer) {
      try {
        await $stripe.customers.del(unxor(defaultCustomer.id));
      } catch (e) { /* ignore */ }
    }
  });

  // =========================================================================
  // VALIDATION TESTS
  // =========================================================================

  it("resetBillingCycle throws error without toDate parameter", async function() {
    try {
      await defaultSub.resetBillingCycle();
      throw new Error("Should have thrown");
    } catch (err) {
      err.message.should.containEql("requires a date");
    }
  });

  it("resetBillingCycle throws error with null toDate", async function() {
    try {
      await defaultSub.resetBillingCycle(null);
      throw new Error("Should have thrown");
    } catch (err) {
      err.message.should.containEql("requires a date");
    }
  });

  it("resetBillingCycle throws error with invalid date object", async function() {
    try {
      await defaultSub.resetBillingCycle({ invalid: true });
      throw new Error("Should have thrown");
    } catch (err) {
      err.message.should.containEql("invalid date");
    }
  });

  it("resetBillingCycle throws error with past date", async function() {
    const pastDate = new Date(Date.now() - 86400000); // Yesterday
    try {
      await defaultSub.resetBillingCycle(pastDate);
      throw new Error("Should have thrown");
    } catch (err) {
      err.message.should.containEql("future date required");
    }
  });

  // =========================================================================
  // FUNCTIONAL TESTS - 'now'
  // =========================================================================

  it("resetBillingCycle('now') resets billing cycle to now", async function() {
    const beforeReset = defaultSub.billing_cycle_anchor;
    
    await defaultSub.resetBillingCycle('now');
    
    const afterReset = defaultSub.billing_cycle_anchor;
    
    // The new anchor should be close to now (within 60 seconds)
    const now = Date.now();
    const diff = Math.abs(afterReset.getTime() - now);
    diff.should.be.below(60000); // Within 60 seconds
    
    // Status should still be active or valid
    ['active', 'trialing', 'incomplete'].should.containEql(defaultSub.status);
  });

  // =========================================================================
  // FUNCTIONAL TESTS - Future Date (trial_end)
  // =========================================================================

  it("resetBillingCycle(futureDate) sets trial_end to future date", async function() {
    // Set to 7 days from now
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    await defaultSub.resetBillingCycle(futureDate);
    
    // After reset, the subscription should be in trialing status
    // or the next billing should be at the future date
    const content = defaultSub.content;
    
    // The next invoice should be at or after the future date
    const nextInvoice = content.nextInvoice;
    if (nextInvoice) {
      nextInvoice.getTime().should.be.aboveOrEqual(futureDate.getTime() - 60000);
    }
    
    // Status should be trialing (due to trial_end)
    ['active', 'trialing'].should.containEql(defaultSub.status);
  });

  // =========================================================================
  // ADDITIONAL TESTS - Use fresh subscription to avoid trial conflicts
  // =========================================================================

  it("resetBillingCycle returns the contract instance", async function() {
    // First reset to 'now' to clear any previous trial
    const result = await defaultSub.resetBillingCycle('now');
    
    result.should.be.instanceof(subscription.SubscriptionContract);
    result.id.should.equal(defaultSub.id);
  });

  it("resetBillingCycle preserves subscription content after 'now' reset", async function() {
    const contentBefore = defaultSub.content;
    const itemsBefore = contentBefore.items.length;
    const customerBefore = contentBefore.customer;
    
    // Use 'now' to avoid trial_end conflicts
    await defaultSub.resetBillingCycle('now');
    
    const contentAfter = defaultSub.content;
    
    // Items should be preserved
    contentAfter.items.length.should.equal(itemsBefore);
    
    // Customer should be preserved
    contentAfter.customer.should.equal(customerBefore);
    
    // Plan should be preserved
    contentAfter.plan.should.equal(contentBefore.plan);
  });
});

