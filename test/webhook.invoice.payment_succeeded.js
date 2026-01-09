/**
 * Karibou payment wrapper
 * Webhook: invoice.payment_succeeded
 * 
 * Tests for invoice.payment_succeeded webhook event
 * - Standard payment with payment_intent in payload
 * - Payment with parent.subscription_details structure (new Stripe API)
 * - Fallback to Stripe API when payment_intent not in payload
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');
const { stripeSubscription } = require('./fixtures/webhook.stripe');

describe("Webhook: invoice.payment_succeeded", function() {
  this.timeout(8000);

  it("Should handle invoice.payment_succeeded webhook with mock payload", async function() {
    // Use the helper function to create mocks
    const mocks = stripeSubscription('invoice.payment_succeeded', {
      customerEmail: "mock-invoice-success@example.com",
      karibouCustomerId: "12345"
    });

    // Mock the Stripe API call to retrieve invoice (API Basil: payment_intent = string ID)
    const originalRetrieve = $stripe.invoices.retrieve;
    $stripe.invoices.retrieve = async function(invoiceId) {
      if (invoiceId === mocks.stripeApiMock.invoiceId) {
        return {
          ...mocks.event.data.object,
          payment_intent: mocks.stripeApiMock.paymentIntentId  // string ID, not object
        };
      }
      return originalRetrieve.call(this, invoiceId);
    };

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
      // Test the webhook with mock event
      const result = await webhook.Webhook.stripe(null, null, { event: mocks.event });

      // Verify the result
      should.exist(result);
      result.event.should.equal('invoice.payment_succeeded');
      should.exist(result.contract);
      result.contract.id.should.equal(mocks.mockContract.id);
      should.exist(result.customer);
      result.customer.uid.should.equal(mocks.mockCustomer.uid);
      should.exist(result.transaction);
      result.transaction.id.should.equal(mocks.mockTransaction.id);
      result.error.should.equal(false);

    } finally {
      // Restore mocks
      $stripe.invoices.retrieve = originalRetrieve;
      subscription.SubscriptionContract.get = originalSubscriptionContractGet;
      customer.Customer.get = originalCustomerGet;
      require("../dist/transaction").Transaction.get = originalTransactionGet;
    }
  });

  it("Should handle invoice.payment_succeeded webhook with parent.subscription_details", async function() {
    const mocks = stripeSubscription('invoice.payment_succeeded', {
      customerEmail: "mock-parent-subscription@example.com",
      karibouCustomerId: "33333",
      subscriptionId: "sub_1TestParentSubscription",
      useParentSubscriptionDetails: true
    });

    // Mock the Stripe API call to retrieve invoice (API Basil: payment_intent = string ID)
    const originalRetrieve = $stripe.invoices.retrieve;
    $stripe.invoices.retrieve = async function(invoiceId) {
      if (invoiceId === mocks.stripeApiMock.invoiceId) {
        return {
          ...mocks.event.data.object,
          payment_intent: mocks.stripeApiMock.paymentIntentId  // string ID, not object
        };
      }
      return originalRetrieve.call(this, invoiceId);
    };

    // Mock dependencies
    const webhook = require("../dist/webhook");
    const originalSubscriptionContractGet = subscription.SubscriptionContract.get;
    const originalTransactionGet = require("../dist/transaction").Transaction.get;
    const originalCustomerGet = customer.Customer.get;

    subscription.SubscriptionContract.get = async function(id) {
      return mocks.mockContract;
    };

    require("../dist/transaction").Transaction.get = async function(id) {
      return mocks.mockTransaction;
    };

    customer.Customer.get = async function(id) {
      return mocks.mockCustomer;
    };

    try {
      const result = await webhook.Webhook.stripe(null, null, { event: mocks.event });

      should.exist(result);
      result.event.should.equal('invoice.payment_succeeded');
      should.exist(result.transaction);
      result.transaction.status.should.equal('succeeded');
      should.exist(result.customer);
      should.exist(result.contract);
      result.contract.id.should.equal(mocks.mockContract.id);
      result.error.should.equal(false);

    } finally {
      $stripe.invoices.retrieve = originalRetrieve;
      subscription.SubscriptionContract.get = originalSubscriptionContractGet;
      require("../dist/transaction").Transaction.get = originalTransactionGet;
      customer.Customer.get = originalCustomerGet;
    }
  });

});

