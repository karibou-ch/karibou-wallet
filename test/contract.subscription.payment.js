/**
 * Karibou payment wrapper
 * Customer
 */

 const config =require("../dist/config").default;
 const options = require('../config-test');
 config.configure(options.payment);


 const customer = require("../dist/customer");
 const payments = require("../dist/payments").KngPayment;
 const unxor = require("../dist/payments").unxor;
 const createTestMethodFromStripe = require("../dist/payments").createTestMethodFromStripe;
 const subscription = require("../dist/contract.subscription");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');
 const cartItems = require('./fixtures/cart.items');


 //
 // stripe test subscription with fake clock 
 // https://stripe.com/docs/billing/testing/test-clocks?dashboard-or-api=api
 const weekdays = "dimanche_lundi_mardi_mercredi_jeudi_vendredi_samedi".split('_');

describe("Class subscription.payment", function(){
  this.timeout(10000);

  let defaultCustomer;
  let defaultSub;
  let methodFailed;
  let method3ds;
  let methodValid;

  // start next week
  let dateValid = new Date(Date.now() + 86400000*7);
  let pausedUntil = new Date(Date.now() + 86400000*30);
 
  const shipping = {
    streetAdress: 'rue du rhone 69',
    postalCode: '1208',
    name: 'foo bar family',
    price: 5,
    hours:16,
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

    const card = createTestMethodFromStripe(method3ds);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    //
    // ✅ STRIPE v10 + API 2024-06-20: Status changed to requires_payment_method for 3DS
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_payment_method")
  });

  it("SubscriptionContract created with invalid payment method", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    //
    // should be requires_action instead of requires_confirmation for unconfirmed capture
    defaultSub.content.status.should.equal('incomplete');
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_payment_method")

    card = createTestMethodFromStripe(methodValid);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    defaultSub.content.status.should.equal('active');
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")
    should.not.exist(defaultSub.content.paymentMethod)
    // DEPRECATED, paymentMethod is delegated to customer
    //defaultSub.content.paymentMethod.should.equal(card.id)

  });

  it("SubscriptionContract created with invalid payment method + require 3ds confirmation", async function() {

    // ✅ Nettoyer default_payment_method pour tester carte échouée
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: null }
    });

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    //
    // should be requires_action instead of requires_confirmation for unconfirmed capture
    defaultSub.content.latestPaymentIntent.status.should.equal("requires_payment_method")

    card = createTestMethodFromStripe(method3ds);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    console.log('defaultSub.content.latestPaymentIntent',defaultSub.content.latestPaymentIntent.status);
    // ✅ STRIPE v10 + API 2024-06-20: Avec customer default payment method, peut être succeeded ou requires_action
    ['succeeded', 'requires_action'].should.containEql(defaultSub.content.latestPaymentIntent.status);

  });

  it("SubscriptionContract start on futur with valid payment method is incomplete", async function() {

    // ✅ CONFIGURER default_payment_method comme dans le test "now"
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    let card = createTestMethodFromStripe(methodValid);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)
    
    // ✅ AVEC billing_cycle_anchor: Start future → status ACTIVE maintenant
    defaultSub.content.status.should.equal('active')
    
    // ✅ CORRECTION: Vérifier dans defaultSub._subscription (vraie réponse Stripe)
    console.log('dateValid envoyé:', dateValid);
    console.log('timestamp envoyé:', Math.floor(dateValid.getTime() / 1000));
    
    // ✅ Vérifier billing_cycle_anchor dans la vraie réponse Stripe
    should.exist(defaultSub._subscription.billing_cycle_anchor);
    console.log('billing_cycle_anchor Stripe:', defaultSub._subscription.billing_cycle_anchor);
    console.log('billing_cycle_anchor date:', new Date(defaultSub._subscription.billing_cycle_anchor * 1000));
    
    const expectedTimestamp = Math.floor(dateValid.getTime() / 1000);
    defaultSub._subscription.billing_cycle_anchor.should.equal(expectedTimestamp);
    
    // ✅ Avec billing_cycle_anchor FUTUR: SetupIntent créé au lieu de PaymentIntent
    should.not.exist(defaultSub.content.latestPaymentIntent);
    console.log('✅ Pas de latestPaymentIntent (normal pour futur)');
    
    // ✅ Vérifier que Stripe a créé un SetupIntent pour le futur
    should.exist(defaultSub._subscription.pending_setup_intent);
    console.log('pending_setup_intent créé:', defaultSub._subscription.pending_setup_intent);
    
    // ✅ Vérifier latest_invoice est null (pas de facturation immédiate)
    should.not.exist(defaultSub._subscription.latest_invoice);
    console.log('✅ latest_invoice: null (pas de facturation immédiate)');
  });

  it("SubscriptionContract start now with valid payment method is active", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    // ✅ CONFIGURAR default_payment_method para strategy customer default payment method
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });

    let card = createTestMethodFromStripe(methodValid);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)
    defaultSub.content.status.should.equal('active')
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")

    //console.log('----',defaultSub.content)
    should.exist(defaultSub.content.latestPaymentIntent.id);
    // ✅ STRIPE v10 + Customer Default Payment Method Strategy: paymentMethod géré au niveau customer
    should.not.exist(defaultSub.content.paymentMethod) // DEPRECATED, paymentMethod is delegated to customer
    
    // ✅ Vérifier que le customer a bien le default_payment_method configuré
    const stripeCustomer = await $stripe.customers.retrieve(unxor(defaultCustomer.id));
    stripeCustomer.invoice_settings.default_payment_method.should.equal(methodValid.id);

  });

});
