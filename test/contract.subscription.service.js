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

describe("Class subscription for service only", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultSub;
  let defaultTx;

  // start next week
  let dateValidNow = new Date(Date.now() + 3600000);
  let dateValid7d = new Date(Date.now() + 86400000*7);
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



  before(async function(){
    config.option('debug',false)
    defaultCustomer = await customer.Customer.create("subscription@email.com","Foo","Bar","022345",1234);
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultTx = await transaction.Transaction.authorize(defaultCustomer,card,2,paymentOpts)

    defaultPaymentAlias = card.alias;
  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
    //await $stripe.subscriptions.del(defaultSub.id);
  });

  it("SubscriptionContract for service with invalid items", async function() {
    try{
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
      const items = cartItems.filter(item => item.frequency == "week");

      const subOptions = { fees:0 };
      defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValidNow,items,subOptions)
      throw "dead code";
    }catch(err){
      err.message.should.containEql("Shipping address is mandatory")
    }
  });  

  it("SubscriptionContract for service with invalid items", async function() {
    try{
      const item = {
        id:'service',
        title:"café",
        price:5.5,
        quantity:1        
      }  
  
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
      const items = [];

      const subOptions = { fees:0 };
      defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValidNow,items,subOptions)
      throw "dead code";
    }catch(err){
      err.message.should.containEql("Missing items")
    }

  });  


  // Simple weekly souscription 
  it("SubscriptionContract create weekly service ", async function() {

    const item = {
      id:'service',
      title:"café",
      price:5.5,
      quantity:1        
    }  

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { fees:0 };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValidNow,[item],subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");
    should.exist(defaultSub.content.latestPaymentIntent);
    defaultSub.content.items.length.should.equal(0);
    defaultSub.content.services.length.should.equal(1);
    const oneDay = 24 * 60 * 60 * 1000;
    const nextInvoice = defaultSub.content.nextInvoice;
    Math.round((nextInvoice - dateValidNow)/oneDay).should.equal(7)

  });

});
