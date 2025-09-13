/**
 * Karibou payment wrapper
 * Customer
 */

 const config =require("../dist/config").default;
 const options = require('../config-test');
 config.configure(options.payment);


 const customer = require("../dist/customer");
 const transaction = require("../dist/transaction");
 const subscription = require("../dist/contract.subscription");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');
 const cartItems = require('./fixtures/cart.items');
 const { Webhook,WebhookContent } = require("../dist/webhook");
 const { unxor, createTestMethodFromStripe } = require("../dist/payments");


 //
 // stripe test subscription with fake clock 
 // https://stripe.com/docs/billing/testing/test-clocks?dashboard-or-api=api
 const weekdays = "dimanche_lundi_mardi_mercredi_jeudi_vendredi_samedi".split('_');

describe("Class subscription.products", function(){
  this.timeout(8000);
  let methodValid;
  let defaultCustomer;
 
  //
  // test card for 3ds
  // https://stripe.com/docs/testing?testing-method=card-numbers#authentification-et-configuration
  before(async function(){
    config.option('debug',false)

    defaultCustomer = await customer.Customer.create("patreon@email.com","Foo","Bar","022345",1234);
    methodValid = await $stripe.paymentMethods.create({
      type: 'card',card: {
        number: '4242 4242 4242 4242',exp_month: 12,exp_year: 2034,cvc: '314'}
      });

    await $stripe.paymentMethods.attach(methodValid.id,{customer:unxor(defaultCustomer.id)});

  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
    //await $stripe.subscriptions.del(defaultSub.id);
  });


  // Simple month souscription for Patreon page
  it("SubscriptionContract list products for patreon", async function() {
    const products = await subscription.SubscriptionContract.listProducts();
    const card = createTestMethodFromStripe(methodValid);
    
    // ✅ FIX Bug 1: Configurer default_payment_method comme dans payment.js
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });
    
    const sub = await subscription.SubscriptionContract.createOnlyFromService(defaultCustomer,card,"month",products[0]);

    should.exist(sub);
    should.exist(sub.content);
    sub.content.status.should.equal('active');
    sub.content.plan.should.equal('patreon');
    sub.content.patreon.length.should.equal(1);
    sub.content.patreon[0].unit_amount.should.equal(products[0].default_price.unit_amount);
    sub.content.patreon[0].id.should.equal(products[0].metadata.title);//Le Premium Double Expresso


    // WARNING: You can only filter subscriptions by prices for recurring purchases
    // const price = products[0].default_price.id;
    // const patreons = await subscription.SubscriptionContract.listAll({status:'active',price});

    //
    // propagation of new or updated data can be up to an hour behind during outages.
    const patreons = await subscription.SubscriptionContract.listAllPatreon();
    should.exist(patreons);
    
    // should.exist(patreons.length);
    // console.log('---',patreons[0])
    // patreons[0].content.id.should.equal(sub.content.id)

  });


});
