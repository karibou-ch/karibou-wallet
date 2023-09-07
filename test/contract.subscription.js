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

describe("Class subscription", function(){
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
    defaultCustomer = await customer.Customer.create("subscription@email.com","Foo","Bar","022345",1234);
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultTx = await transaction.Transaction.authorize(defaultCustomer,card,2,paymentOpts)

    defaultPaymentAlias = card.alias;
  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
    //await $stripe.subscriptions.del(defaultSub.id);
  });

  // Simple weekly souscription 
  it("SubscriptionContract create weekly with invalid item", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.slice();
    try{
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);

      const subOptions = { shipping,dayOfWeek,fees };
      defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValidNow,items,subOptions)
      throw "error";
    }catch(err){
      err.message.should.containEql('incorrect item format')
    }

  });  

  // Simple weekly souscription 
  it("SubscriptionContract create weekly", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "week");

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValidNow,items,subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");
    defaultSub.content.items.length.should.equal(2);
    defaultSub.content.services.length.should.equal(2);
    const oneDay = 24 * 60 * 60 * 1000;
    const nextInvoice = defaultSub.content.nextInvoice;
    Math.round((nextInvoice - dateValidNow)/oneDay).should.equal(7)

  });

  // Simple weekly souscription 
  it("SubscriptionContract create montly", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "month");

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"month",dateValid7d,items,subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");
    should.not.exist(defaultSub.content.latestPaymentIntent);
    defaultSub.content.items.length.should.equal(1);
    defaultSub.content.services.length.should.equal(2);
    const nextInvoice = defaultSub.content.nextInvoice;
    ((dateValidNow.getMonth() + 1)%12).should.equal(nextInvoice.getMonth());

  });

  it("SubscriptionContract get default payment method and customer from id", async function() {

    defaultSub = await subscription.SubscriptionContract.get(defaultSub.id)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.items.length.should.equal(1);
    defaultSub.content.services.length.should.equal(2);

    defaultSub.content.services.every(item => item.id && item.title && item.fees && item.quantity).should.equal(true)
    //
    // verify customer 
    const customer = await defaultSub.customer();
    customer.id.should.equal(defaultCustomer.id);

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
    contracts.length.should.equal(2);

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

  it("pause weekly sub for 30 days", async function() {
    const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
    const contract = contracts.find(contract => contract.content.frequency == 'week');

    should.exist(contract);    
    contract.content.status.should.equal('active');
    await contract.pause(pausedUntil);
    contract.content.status.should.equal('paused');
    const content = contract.content;
    console.log('\n-- ',content.status,content.description,'resumed on',new Date(contract.pausedUntil),'(',(contract.pausedUntil-new Date())/86400000|0,'d)');        
  });

  it("manualy resume paused sub ", async function() {
    const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
    const contract = contracts.find(contract => contract.interval.frequency == 'week');
    contract.content.status.should.equal('paused');

    should.exist(contract);
    await contract.resumeManualy();
    contract.content.status.should.equal('active');
    // console.log('\n-- ',contract.status,contract.description,defaultCustomer.name, contract.pausedUntil);        
  });



  //
  // testing webhook
  // https://github.com/stripe/stripe-node/blob/master/README.md#testing-webhook-signing
  // https://stripe.com/docs/billing/subscriptions/webhooks#payment-failures
  // customer.subscription.paused	
  // customer.subscription.resumed
  // customer.subscription.trial_will_end	
  // payment_intent.created	
  // payment_intent.succeeded	
  // invoice.payment_failed
  // invoice.upcoming

  // Simple weekly souscription 
  it("Webhook.stripe invoice.upcoming", async function() {
    config.option('debug',true);
    const EVENT_upcoming = {
      type: 'invoice.upcoming',
      data: {object:{
        subscription:defaultSub.id
      }}      
    };
    try{
      const content = await Webhook.stripe(EVENT_upcoming,'hello');
      content.contract.id.should.equal(defaultSub.id);
      content.error.should.equal(false);      
    }catch(err) {
      //console.log('---ERR',err.message)
    }
  });
	

  it("Webhook.stripe invoice.payment_failed", async function() {
    config.option('debug',true);
    const EVENT_payment_failed = {
      type: 'invoice.payment_failed',
      data: {object:{
        subscription:defaultSub.id,
        payment_intent: defaultTx.id
      }}      
    };
    try{
      const content = await Webhook.stripe(EVENT_payment_failed,'hello');
      content.contract.id.should.equal(defaultSub.id);
      content.transaction.id.should.equal(defaultTx.id);
      content.error.should.equal(true);      
    }catch(err) {
      //console.log('---ERR',err.message)
    }
  });
	

  it("Webhook.stripe invoice.payment_succeeded", async function() {
    config.option('debug',true);
    const EVENT_payment_succeeded = {
      type: 'invoice.payment_succeeded',
      data: {object:{
        subscription:defaultSub.id,
      }}      
    };
    try{
      const content = await Webhook.stripe(EVENT_payment_succeeded,'hello');
      content.contract.id.should.equal(defaultSub.id);
      content.error.should.equal(false);      
    }catch(err) {
      //console.log('---ERR',err.message)
    }
  });
	  

});
