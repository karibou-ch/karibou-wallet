/**
 * Karibou payment wrapper
 * Customer
 */

 const config =require("../dist/config").default;
 const options = require('../config-test');
 config.configure(options.payment);


 const customer = require("../dist/customer");
 const transaction = require("../dist/transaction");
 const payments = require("../dist/payments").KngPayment;
 const unxor = require("../dist/payments").unxor;
 const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
 const createTestMethodFromStripe = require("../dist/payments").createTestMethodFromStripe;
 const subscription = require("../dist/contract.subscription");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');
 const cartItems = require('./fixtures/cart.items');
const { Webhook,WebhookContent } = require("../dist/webhook");


 //
 // stripe test subscription with fake clock 
 // https://stripe.com/docs/billing/testing/test-clocks?dashboard-or-api=api
 const weekdays = "dimanche_lundi_mardi_mercredi_jeudi_vendredi_samedi".split('_');

describe("Class subscription.use customer default payment method", function(){
  this.timeout(10000);

  let defaultCustomer;
  let defaultSub;
  let methodFailed;
  let method3ds;
  let methodValid;

  // start next week
  let dateValid = new Date(Date.now() + 86400000*7);
 
  const shipping = {
    streetAdress: 'rue du rhone 69',
    postalCode: '1208',
    name: 'foo bar family',
    price: 5,
    hours:16,
    lat:1,
    lng:2
  };


  //
  // test card for 3ds
  // https://stripe.com/docs/testing?testing-method=card-numbers#authentification-et-configuration
  before(async function(){
    defaultCustomer = await customer.Customer.create("subscription@email.com","Foo","Bar","022345",1234);
    methodFailed = await $stripe.paymentMethods.create({
      type: 'card',card: {
        number: '4000000000000341',exp_month: 12,exp_year: 2034,cvc: '314'}
      });

    await $stripe.paymentMethods.attach(methodFailed.id,{customer:unxor(defaultCustomer.id)});

    method3ds = await $stripe.paymentMethods.create({
      type: 'card',card: {
        number: '4000000000003220',exp_month: 12,exp_year: 2034,cvc: '314'}
      });

    await $stripe.paymentMethods.attach(method3ds.id,{customer:unxor(defaultCustomer.id)});

    methodValid = await $stripe.paymentMethods.create({
      type: 'card',card: {
        number: '4242424242424242',exp_month: 12,exp_year: 2034,cvc: '314'}
      });

    await $stripe.paymentMethods.attach(methodValid.id,{customer:unxor(defaultCustomer.id)});

  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
    //await $stripe.subscriptions.del(defaultSub.id);
  });


  // Simple weekly souscription 
  // https://stripe.com/docs/billing/testing?dashboard-or-api=api#payment-failures
  // failure 4000 0000 0000 0341
  // 3ds  4000 0000 0000 3063
  it("SubscriptionContract created require 3ds confirmation", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // Set the 3DS card as the customer's default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: method3ds.id }
    });

    const card = createTestMethodFromStripe(method3ds);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    //
    // should be requires_action because the customer's default card requires 3DS
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_action")
    // The subscription itself should not have a default payment method
    should.equal(defaultSub._subscription.default_payment_method, null);
  });

  it("SubscriptionContract created with invalid payment method", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");
    
    // Set the failing card as the customer's default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    //
    // The initial payment fails, so it requires a new payment method
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_payment_method")

    // Now, update with a valid card
    card = createTestMethodFromStripe(methodValid);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")
    // The payment method on the contract should BE null because the customer's default payment method is used
    should.not.exist(defaultSub.content.paymentMethod)
    // The subscription itself should still not have a default payment method
    should.equal(defaultSub._subscription.default_payment_method, null);

  });

  it("SubscriptionContract created with invalid payment method + require 3ds confirmation", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // Start with a failing card as default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    //
    // requires a new method because the default one failed
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_payment_method")

    // Update with a 3DS card
    card = createTestMethodFromStripe(method3ds);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    // The status should now be requires_action for the 3DS flow
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_action")
    // The payment method on the contract should BE null because the customer's default payment method is used
    should.not.exist(defaultSub.content.paymentMethod)
    should.equal(defaultSub._subscription.default_payment_method, null);
  });

  it("SubscriptionContract start on futur with valid payment method is active", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // Set a valid card as the customer's default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });

    let card = createTestMethodFromStripe(methodValid);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)
    defaultSub.content.status.should.equal('active')
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")
    should.equal(defaultSub._subscription.default_payment_method, null);
  });

  it("SubscriptionContract start now with valid payment method is active", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // Set a valid card as the customer's default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });

    let card = createTestMethodFromStripe(methodValid);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)
    defaultSub.content.status.should.equal('active')
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")

    //console.log('----',defaultSub.content)
    should.exist(defaultSub.content.latestPaymentIntent.id);
    // The payment method on the contract should BE null because the customer's default payment method is used
    should.not.exist(defaultSub.content.paymentMethod)
    should.equal(defaultSub._subscription.default_payment_method, null);
  });

});
