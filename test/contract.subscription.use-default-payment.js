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
  this.timeout(20000);

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
    if (!defaultCustomer) return;
    await $stripe.customers.del(unxor(defaultCustomer.id));
    //await $stripe.subscriptions.del(defaultSub.id);
  });


  // Cartes: 0341 refuse, 3220 3DS required (docs/testing). 3063 est obsolète.
  // Workflow: wallet prépare le PI, front confirmCardPayment. Ici on n'appelle pas confirm Node.
  it("B1 create now 3220 leaves PI open for confirmCardPayment", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // Set the 3DS card as the customer's default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: method3ds.id }
    });

    const card = createTestMethodFromStripe(method3ds);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    // Stripe: 3DS = requires_action après tentative; sans confirm = souvent requires_confirmation.
    const open3ds = ["requires_confirmation", "requires_action"];
    open3ds.should.containEql(defaultSub.content.latestPaymentIntent.status);
    // The subscription itself should not have a default payment method
    should.equal(defaultSub._subscription.default_payment_method, null);
  });

  it("B1c create 0341 then mocha stand-in 4242 confirmCardPayment → succeeded", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");
    
    // Set the failing card as the customer's default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret);
    const openFailed = ["requires_confirmation", "requires_payment_method"];
    openFailed.should.containEql(defaultSub.content.latestPaymentIntent.status);

    // Wallet attache la carte au PI, le charge se confirme au front
    card = createTestMethodFromStripe(methodValid);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    should.not.exist(defaultSub.content.paymentMethod)
    should.equal(defaultSub._subscription.default_payment_method, null);
    defaultSub.content.latestPaymentIntent.status.should.not.equal("succeeded")
    // 4242: stand-in de confirmCardPayment (carte non enrôlée 3DS). Pas un test 3DS.
    await $stripe.paymentIntents.confirm(defaultSub.content.latestPaymentIntent.id);
    defaultSub = await defaultSub.confirmPendingPayment(defaultSub.content.latestPaymentIntent.id);
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")

  });

  it("C4 attach 3220 leaves PI open (no Node confirm)", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // Start with a failing card as default
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret);
    const openFailed3ds = ["requires_confirmation", "requires_payment_method"];
    openFailed3ds.should.containEql(defaultSub.content.latestPaymentIntent.status);

    card = createTestMethodFromStripe(method3ds);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    should.not.exist(defaultSub.content.paymentMethod)
    should.equal(defaultSub._subscription.default_payment_method, null);
    defaultSub.content.latestPaymentIntent.status.should.not.equal("succeeded")
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)
  });

  it("B2a create trial_end exposes no invoice PI", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });

    let card = createTestMethodFromStripe(methodValid);
    const subOptions = { shipping,dayOfWeek,fees, useCustomerDefaultPaymentMethod: true };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    defaultSub.content.status.should.equal('active')
    should.equal(defaultSub._subscription.default_payment_method, null);
    should.not.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub._subscription.trial_end);
    defaultSub._subscription.trial_end.should.equal(Math.floor(dateValid.getTime() / 1000));
  });

  it("B1 after mocha stand-in 4242 confirmCardPayment subscription is active", async function() {

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
    if (defaultSub.content.latestPaymentIntent.status !== "succeeded") {
      // 4242: stand-in de confirmCardPayment (pas de challenge 3DS).
      await $stripe.paymentIntents.confirm(defaultSub.content.latestPaymentIntent.id);
      defaultSub = await defaultSub.confirmPendingPayment(defaultSub.content.latestPaymentIntent.id);
    }
    defaultSub.content.status.should.equal('active')
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")

    should.exist(defaultSub.content.latestPaymentIntent.id);
    // The payment method on the contract should BE null because the customer's default payment method is used
    should.not.exist(defaultSub.content.paymentMethod)
    should.equal(defaultSub._subscription.default_payment_method, null);
  });

});
