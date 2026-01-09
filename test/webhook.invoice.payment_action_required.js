/**
 * Karibou payment wrapper
 * Webhook: invoice.payment_action_required
 * 
 * Tests for invoice.payment_action_required webhook event
 * - Triggered when 3D Secure authentication is required
 * - Customer has 23h to complete authentication
 * - Payment intent status: requires_action
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');
const { stripeSubscription } = require('./fixtures/webhook.stripe');

describe("Webhook: invoice.payment_action_required", function() {
  this.timeout(8000);

  it("Should handle invoice.payment_action_required webhook", async function() {
    const mocks = stripeSubscription('invoice.payment_action_required', {
      customerEmail: "mock-action-required@example.com",
      karibouCustomerId: "11111"
    });

    // Mock the Stripe API call to retrieve invoice (API Basil: payment_intent = string ID)
    const originalRetrieve = $stripe.invoices.retrieve;
    $stripe.invoices.retrieve = async function(invoiceId) {
      return {
        ...mocks.event.data.object,
        payment_intent: mocks.event.data.object.payment_intent  // string ID
      };
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
      const result = await webhook.Webhook.stripe(null, null, { event: mocks.event });

      should.exist(result);
      result.event.should.equal('invoice.payment_action_required');
      should.exist(result.contract);
      should.exist(result.customer);
      should.exist(result.transaction);
      result.transaction.status.should.equal('requires_action');
      should.exist(result.transaction.client_secret);
      should.exist(result.transaction.next_action);
      result.error.should.equal(false);

    } finally {
      $stripe.invoices.retrieve = originalRetrieve;
      subscription.SubscriptionContract.get = originalSubscriptionContractGet;
      customer.Customer.get = originalCustomerGet;
      require("../dist/transaction").Transaction.get = originalTransactionGet;
    }
  });

});

