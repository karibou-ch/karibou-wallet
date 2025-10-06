/**
 * Karibou payment wrapper
 * Webhook: payment_intent.succeeded
 * 
 * Tests for payment_intent.succeeded webhook event
 * - Triggered for TWINT, ApplePay, and other payment methods
 * - Payment successfully completed
 * - Transaction status: succeeded
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const should = require('should');
const { stripeSubscription } = require('./fixtures/webhook.stripe');

describe("Webhook: payment_intent.succeeded", function() {
  this.timeout(8000);

  it("Should handle payment_intent.succeeded webhook", async function() {
    const mocks = stripeSubscription('payment_intent.succeeded', {
      customerEmail: "mock-intent-success@example.com",
      karibouCustomerId: "22222"
    });

    // Mock dependencies
    const webhook = require("../dist/webhook");
    const originalTransactionGet = require("../dist/transaction").Transaction.get;
    const originalCustomerGet = customer.Customer.get;

    require("../dist/transaction").Transaction.get = async function(id) {
      return mocks.mockTransaction;
    };

    customer.Customer.get = async function(id) {
      return mocks.mockCustomer;
    };

    try {
      const result = await webhook.Webhook.stripe(null, null, { event: mocks.event });

      should.exist(result);
      result.event.should.equal('payment_intent.succeeded');
      should.exist(result.transaction);
      result.transaction.status.should.equal('succeeded');
      should.exist(result.customer);
      // result.error can be false, null, undefined, or a string message
      if (result.error !== false && result.error !== null && result.error !== undefined && typeof result.error !== 'string') {
        throw new Error(`Unexpected error value: ${result.error} (type: ${typeof result.error})`);
      }

    } finally {
      require("../dist/transaction").Transaction.get = originalTransactionGet;
      customer.Customer.get = originalCustomerGet;
    }
  });

});

