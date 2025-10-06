/**
 * Karibou payment wrapper
 * Webhook: payment_intent.payment_failed
 * 
 * Tests for payment_intent.payment_failed webhook event
 * - Triggered when payment fails (card declined, insufficient funds, etc.)
 * - Includes last_payment_error with failure details
 * - Transaction status: requires_payment_method
 * 
 * TODO: Implement tests for this webhook event
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const should = require('should');

describe("Webhook: payment_intent.payment_failed", function() {
  this.timeout(8000);

  it.skip("Should handle payment_intent.payment_failed webhook", async function() {
    // TODO: Implement test
    // 1. Create mock payment_intent with last_payment_error
    // 2. Mock Transaction.get
    // 3. Mock Customer.get
    // 4. Verify error message is extracted
    // 5. Verify transaction and customer are returned
  });

  it.skip("Should handle card_declined error", async function() {
    // TODO: Implement test
    // 1. Create mock with last_payment_error.type = 'card_declined'
    // 2. Verify error message is correct
    // 3. Verify appropriate response structure
  });

  it.skip("Should handle insufficient_funds error", async function() {
    // TODO: Implement test
    // 1. Create mock with last_payment_error.type = 'insufficient_funds'
    // 2. Verify error message is correct
    // 3. Verify appropriate response structure
  });

});

