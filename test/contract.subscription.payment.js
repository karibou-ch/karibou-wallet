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


  // 3220 = 3DS required. Wallet ne confirme pas: PI ouvert + client_secret pour confirmCardPayment.
  it("B1 create now 3220 leaves PI open for confirmCardPayment", async function() {

    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: method3ds.id }
    });

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    const card = createTestMethodFromStripe(method3ds);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    const open3ds = ["requires_confirmation", "requires_action"];
    open3ds.should.containEql(defaultSub.content.latestPaymentIntent.status);
    defaultSub.content.latestPaymentIntent.status.should.not.equal("succeeded")
  });

  it("B1c create 0341 then mocha stand-in 4242 confirmCardPayment → active", async function() {

    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    let card = createTestMethodFromStripe(methodFailed);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
    should.exist(defaultSub.content.latestPaymentIntent);
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

    defaultSub.content.status.should.equal('incomplete');
    const openFailed = ["requires_confirmation", "requires_payment_method"];
    openFailed.should.containEql(defaultSub.content.latestPaymentIntent.status);

    card = createTestMethodFromStripe(methodValid);
    defaultSub = await defaultSub.updatePaymentMethod(card);
    should.not.exist(defaultSub.content.paymentMethod)
    defaultSub.content.latestPaymentIntent.status.should.not.equal("succeeded")
    // 4242: stand-in mocha de confirmCardPayment (pas de challenge 3DS).
    await $stripe.paymentIntents.confirm(defaultSub.content.latestPaymentIntent.id);
    defaultSub = await defaultSub.confirmPendingPayment(defaultSub.content.latestPaymentIntent.id);
    defaultSub.content.status.should.equal('active');
    defaultSub.content.latestPaymentIntent.status.should.equal("succeeded")
    // DEPRECATED, paymentMethod is delegated to customer
    //defaultSub.content.paymentMethod.should.equal(card.id)

  });

  it("C4 attach 3220 leaves PI open (no Node confirm)", async function() {

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
    defaultSub.content.latestPaymentIntent.status.should.not.equal("succeeded")
    should.exist(defaultSub.content.latestPaymentIntent.client_secret)

  });

  it("B2a create trial_end exposes no invoice PI", async function() {

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
    
    // Start future uses Stripe trialing to avoid immediate billing, but the
    // business status remains active unless metadata.pausedUntil marks a pause.
    defaultSub.content.status.should.equal('active')
    defaultSub.content.issue.should.equal('trialing')
    
    // ✅ CORRECTION: Vérifier dans defaultSub._subscription (vraie réponse Stripe)
    console.log('dateValid envoyé:', dateValid);
    console.log('timestamp envoyé:', Math.floor(dateValid.getTime() / 1000));
    
    // ✅ Vérifier trial_end dans la vraie réponse Stripe
    should.exist(defaultSub._subscription.trial_end);
    console.log('trial_end Stripe:', defaultSub._subscription.trial_end);
    console.log('trial_end date:', new Date(defaultSub._subscription.trial_end * 1000));
    
    const expectedTimestamp = Math.floor(dateValid.getTime() / 1000);
    defaultSub._subscription.trial_end.should.equal(expectedTimestamp);
    defaultSub.content.nextInvoice.getTime().should.equal(expectedTimestamp * 1000);
    
    // ✅ Avec trial_end FUTUR: pas de PaymentIntent immédiat
    should.not.exist(defaultSub.content.latestPaymentIntent);
    console.log('✅ Pas de latestPaymentIntent (normal pour futur)');
    
    // ✅ Avec trial_end, Stripe crée une invoice de trial à 0 CHF, sans PaymentIntent
    should.exist(defaultSub._subscription.latest_invoice);
    defaultSub._subscription.latest_invoice.total.should.equal(0);
    should.not.exist(defaultSub._subscription.latest_invoice.payment_intent);
    console.log('✅ latest_invoice de trial à 0 CHF, sans PaymentIntent');
  });

  it("B1 after mocha stand-in 4242 confirmCardPayment subscription is active", async function() {

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
    if (defaultSub.content.latestPaymentIntent.status !== "succeeded") {
      // 4242: stand-in de confirmCardPayment (pas de challenge 3DS).
      await $stripe.paymentIntents.confirm(defaultSub.content.latestPaymentIntent.id);
      defaultSub = await defaultSub.confirmPendingPayment(defaultSub.content.latestPaymentIntent.id);
    }
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
