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


 //
 // stripe test subscription with fake clock 
 // https://stripe.com/docs/billing/testing/test-clocks?dashboard-or-api=api
 const weekdays = "dimanche_lundi_mardi_mercredi_jeudi_vendredi_samedi".split('_');

describe("contract.subscription.invoice", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultSub;
  let defaultTx;

  // start next week
  let dateNow = new Date();
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



  before(async function(){
    defaultCustomer = await customer.Customer.create("subscription@email.com","Foo","Bar","022345",1234);
    const method = await defaultCustomer.allowCredit(true);
    should.exist(defaultCustomer);
    defaultPaymentAlias = method.alias;
  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
  });

  // Simple weekly souscription 
  it("SubscriptionContract create weekly", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValid,items,subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");
    defaultSub.content.items[0].hub.should.equal('mocha');
    defaultSub.content.items[1].hub.should.equal('mocha');
    defaultSub.content.items.length.should.equal(2);
    defaultSub.content.items.forEach(item => {
      const elem = items.find(itm => itm.sku == item.sku);
      elem.price.should.equal(item.fees);
      item.unit_amount.should.equal(0);
    });

    defaultSub.content.fees.should.equal(0.06)

    const s_shipping = defaultSub.content.services.find(item => item.title=='shipping');
    s_shipping.fees.should.equal(5);
    const s_karibou = defaultSub.content.services.find(item => item.title=='karibou.ch');
    const oneDay = 24 * 60 * 60 * 1000;
    const nextInvoice = defaultSub.content.nextInvoice;
    Math.round((nextInvoice - dateNow)/oneDay).should.equal(7)

  });

  it("SubscriptionContract get default payment method and customer from id", async function() {

    defaultSub = await subscription.SubscriptionContract.get(defaultSub.id)


    //
    // verify customer 
    const customer = await defaultSub.customer();

    //
    // verify payment
    const pid = defaultSub.paymentMethod;
    const card = customer.findMethodByID(pid);
    should.exist(card);

  });

  it("SubscriptionContract try to remove payment method used from sub", async function() {
    try{
      config.option('debug',false);

      const customer = await defaultSub.customer();
  
      //
      // verify payment
      const pid = defaultSub.paymentMethod;
      pid.should.equal('invoice');
      const card = customer.findMethodByID(pid);
      should.exist(card);
      await customer.removeMethod(card);
  
    }catch(err) {
      should.not.exist(err);
      // DEPRECATED 
      //err.message.should.containEql('Impossible de supprimer');

    }
  });

  it("SubscriptionContract cancel", async function() {
    defaultSub = await subscription.SubscriptionContract.get(defaultSub.id);
    await defaultSub.cancel();
  });


  it("list all SubscriptionContract for one customer", async function() {
    const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
    contracts.length.should.equal(1);

  });

});
