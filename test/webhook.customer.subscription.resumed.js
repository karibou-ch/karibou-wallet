/**
 * Karibou payment wrapper
 * Webhook: customer.subscription.resumed
 * 
 * Tests for customer.subscription.resumed webhook event
 * - Triggered when paused subscription is resumed
 * - Subscription billing restarts
 * - Returns contract and customer
 * 
 * TODO: Implement tests for this webhook event
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const should = require('should');

describe("Webhook: customer.subscription.resumed", function() {
  this.timeout(8000);

  it.skip("Should handle customer.subscription.resumed webhook", async function() {
    // TODO: Implement test
    // 1. Create mock Stripe subscription with status='active' (resumed)
    // 2. Mock SubscriptionContract.get
    // 3. Verify contract and customer are returned
    // 4. Verify resume date is recorded
  });

  it.skip("Should verify payment method on resume", async function() {
    // TODO: Implement test
    // 1. Create mock resumed subscription
    // 2. Verify payment method is valid
    // 3. Verify billing will restart correctly
  });

});

