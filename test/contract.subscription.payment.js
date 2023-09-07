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
 const subscription = require("../dist/contract.subscription");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');
 const cartItems = require('./fixtures/cart.items');
const { Webhook,WebhookContent } = require("../dist/webhook");
const { card_authenticationRequired, createTestMethodFromStripe } = require("../dist/payments");


 //
 // stripe test subscription with fake clock 
 // https://stripe.com/docs/billing/testing/test-clocks?dashboard-or-api=api
 const weekdays = "dimanche_lundi_mardi_mercredi_jeudi_vendredi_samedi".split('_');

describe("Class subscription.payment", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultSub;
  let methodFailed;
  let method3ds;

  // start next week
  let dateValid = new Date(Date.now() + 86400000*7);
  let pausedUntil = new Date(Date.now() + 86400000*30);
 
  const shipping = {
    streetAdress: 'rue du rhone 69',
    postalCode: '1208',
    name: 'foo bar family',
    price: 5,
    lat:1,
    lng:2
  };

  const paymentOpts = {
    oid: '01234',
    txgroup: 'AAA',
    shipping: {
        streetAdress: 'rue du rhone 69',
        postalCode: '1208',
        name: 'Cash balance testing family'
    }
  };


  //
  // test card for 3ds
  // https://stripe.com/docs/testing?testing-method=card-numbers#authentification-et-configuration
  before(async function(){
    defaultCustomer = await customer.Customer.create("subscription@email.com","Foo","Bar","022345",1234);
    methodFailed = await $stripe.paymentMethods.create({
      type: 'card',card: {
        number: '4000008260003178',exp_month: 12,exp_year: 2034,cvc: '314'}
      });

    await $stripe.paymentMethods.attach(methodFailed.id,{customer:unxor(defaultCustomer.id)});

    method3ds = await $stripe.paymentMethods.create({
      type: 'card',card: {
        number: '4000000000003063',exp_month: 12,exp_year: 2034,cvc: '314'}
      });

    await $stripe.paymentMethods.attach(method3ds.id,{customer:unxor(defaultCustomer.id)});
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

    const card = createTestMethodFromStripe(method3ds);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    console.log('--- should be requires_action',defaultSub.content.latestPaymentIntent.status)
    // should be requires_action
    //defaultSub.content.latestPaymentIntent.status.should.equal("requires_confirmation")
  });


  xit("SubscriptionContract confirm payment intent", async function() {
    defaultSub = await subscription.SubscriptionContract.get(defaultSub.id);
    // const tx = await transaction.Transaction.get(defaultSub.content.latestPaymentIntent.id);
    const result = await transaction.Transaction.confirm(defaultSub.content.latestPaymentIntent.client_secret);
    console.log('---',result)

  })

  xit("SubscriptionContract created with ans invalid payment method", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    const card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    console.log('--- should be requires_confirmation',defaultSub.content.latestPaymentIntent.status)

    // console.log('---- 0',defaultSub.content.latestPaymentIntent)
    // should be requires_payment_method
    //defaultSub.content.latestPaymentIntent.status.should.equal("requires_confirmation")
  });


});
