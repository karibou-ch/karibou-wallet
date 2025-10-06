/**
 * Karibou payment wrapper
 * Webhook: invoice.payment_failed
 * 
 * Tests for invoice.payment_failed webhook event
 * - Triggered when subscription payment fails
 * - Card declined, expired, or insufficient funds
 * - Customer has 23h to update payment method (smart retries)
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const should = require('should');
const { stripeSubscription } = require('./fixtures/webhook.stripe');

describe('Webhook: invoice.payment_failed', function() {
  this.timeout(8000);

  it("Should handle invoice.payment_failed webhook", async function() {
    const mocks = stripeSubscription('invoice.payment_failed', {
      customerEmail: "mock-payment-failed@example.com",
      karibouCustomerId: "67890"
    });

    // Mock dependencies
    const webhook = require("../dist/webhook");
    const originalSubscriptionContractGet = subscription.SubscriptionContract.get;
    const originalCustomerGet = customer.Customer.get;
    const originalTransactionGet = require("../dist/transaction").Transaction.get;

    subscription.SubscriptionContract.get = async function(id) {
      return mocks.mockContract;
    };

    customer.Customer.get = async function(id) {
      return mocks.mockCustomer;
    };

    require("../dist/transaction").Transaction.get = async function(id) {
      return mocks.mockTransaction;
    };

    try {
      const result = await webhook.Webhook.stripe(null, null, { event: mocks.event });

      should.exist(result);
      result.event.should.equal('invoice.payment_failed');
      should.exist(result.contract);
      should.exist(result.customer);
      should.exist(result.transaction);
      result.transaction.status.should.equal('requires_payment_method');
      should.exist(result.transaction.last_payment_error);
      result.error.should.equal(false);

    } finally {
      subscription.SubscriptionContract.get = originalSubscriptionContractGet;
      customer.Customer.get = originalCustomerGet;
      require("../dist/transaction").Transaction.get = originalTransactionGet;
    }
  });

});