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
    defaultSub.content.items.length.should.equal(2);
    defaultSub.content.services.length.should.equal(2);
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
      const card = customer.findMethodByID(pid);
      should.exist(card);
      await customer.removeMethod(card);
      should.not.exist(true);
  
    }catch(err) {
      should.exist(err);
      err.message.should.containEql('Impossible de supprimer');

    }
  });

  it("list all SubscriptionContract for one customer", async function() {
    const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
    contracts.length.should.equal(1);
    contracts.forEach(contract=> {
      const content = contract.content;
      console.log('\n     ------------------------------- ');
      console.log('-- ',content.status,content.description, defaultCustomer.name);
      console.log('-- ',content.frequency," ",content.dayOfWeek, content.start);
      console.log('-- ',contract.shipping.name,contract.shipping.streetAdress,contract.shipping.postalCode);
      console.log('-- articles ');
      content.items.forEach(item=> {
        console.log('   ',item.title,item.sku,item.quantity * (item.unit_amount/100), 'chf',item.quantity);
      })
      console.log('-- services ');
      content.services.forEach(service=> {
        console.log('   ',service.id, 'chf',service.fees);
      })

    });

  });

});
