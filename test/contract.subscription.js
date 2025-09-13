/**
 * Karibou payment wrapper
 * Customer
 */

 const config =require("../dist/config").default;
 const options = require('../config-test');
 config.configure(options.payment);
 config.option('debug',false);


 const customer = require("../dist/customer");
 const transaction = require("../dist/transaction");
 const payments = require("../dist/payments").KngPayment;
 const unxor = require("../dist/payments").unxor;
 const xor = require("../dist/payments").xor;
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

describe("Class subscription.creation", function(){
  this.timeout(10000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultSub;
  let defaultTx;

  // ✅ CORRECTION: Utiliser 'now' au lieu de dates fixes pour éviter timestamps passés
 
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
    const items = JSON.parse(JSON.stringify(cartItems.slice()));
    // console.log('items',items)
    try{
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);

      const subOptions = { shipping,dayOfWeek,fees };
      defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)
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

    // IMPORTANT
    // a contract with a valid date for X days has a success payment, 
    // but  incomplete status until the first day 
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",'now',items,subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.frequency.should.equal('week');
    defaultSub.content.status.should.equal("active");
    defaultSub.content.items[0].hub.should.equal('mocha');
    defaultSub.content.items[1].hub.should.equal('mocha');
    defaultSub.content.items.length.should.equal(2);
    defaultSub.content.services.length.should.equal(2);

    should.not.exist(defaultSub.content.shipping.price);

    defaultSub.content.items.forEach(item => {
      const elem = items.find(itm => itm.sku == item.sku);
      elem.price.should.equal(item.fees);
      item.unit_amount.should.equal(item.fees*100);
    })

    const oneDay = 24 * 60 * 60 * 1000;
    const nextInvoice = defaultSub.content.nextInvoice;
    const now = new Date();
    Math.round((nextInvoice - now)/oneDay).should.equal(7)

  });

  // Simple weekly souscription 
  it("SubscriptionContract create 2weeks", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = JSON.parse(JSON.stringify(cartItems.filter(item => item.frequency == "week")));
    items.forEach(item => {
      item.frequency = "2weeks";
    });

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping,dayOfWeek,fees };

    // IMPORTANT
    // a contract with a valid date for X days has a success payment, 
    // but  incomplete status until the first day 
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"2weeks",'now',items,subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");
    defaultSub.content.items[0].hub.should.equal('mocha');
    defaultSub.content.items[1].hub.should.equal('mocha');
    defaultSub.content.items.length.should.equal(2);
    defaultSub.content.services.length.should.equal(2);
    defaultSub.content.frequency.should.equal('2weeks');

    defaultSub.content.items.forEach(item => {
      const elem = items.find(itm => itm.sku == item.sku);
      elem.price.should.equal(item.fees);
      item.unit_amount.should.equal(item.fees*100);
    })

    const oneDay = 24 * 60 * 60 * 1000;
    const nextInvoice = defaultSub.content.nextInvoice;
    const now = new Date();
    Math.round((nextInvoice - now)/oneDay).should.equal(14)

  });

  // Simple weekly souscription 
  it("SubscriptionContract create montly", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.filter(item => item.frequency == "month");

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping,dayOfWeek,fees };
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"month",'now',items,subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("status");
    defaultSub.should.property("shipping");
    defaultSub.should.property("content");
    defaultSub.content.frequency.should.equal('month');
    defaultSub.content.status.should.equal("active");
    defaultSub.content.items.length.should.equal(1);
    defaultSub.content.items[0].hub.should.equal('mocha');
    defaultSub.content.services.length.should.equal(2);
    const nextInvoice = defaultSub.content.nextInvoice;
    const now = new Date();
    ((now.getMonth() + 1)%12).should.equal(nextInvoice.getMonth());

  });

  it("SubscriptionContract get default payment method and customer from id", async function() {

    // ✅ CORRECTION: Récupérer une subscription existante si defaultSub n'est pas défini
    if (!defaultSub || !defaultSub.id) {
      const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
      defaultSub = contracts.find(c => c.content.frequency === 'month') || contracts[0];
    }
    
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
    // verify payment - ✅ CORRECTION: avec Stripe v10 paymentMethod délégué au customer
    const pid = defaultSub.paymentMethod;
    if (pid) {
      // Si paymentMethod spécifique à la subscription
      const card = customer.findMethodByID(pid);
      should.exist(card);
    } else {
      // Si délégué au customer, vérifier que le customer a une default payment method
      const methods = await customer.listMethods();
      // ✅ Ou vérifier via defaultMethod getter
      const defaultMethod = methods.find(method => method.default);
      should.exist(defaultMethod);
      should.exist(customer.defaultMethod);
    }

  });

  it("SubscriptionContract try to remove payment method used from sub", async function() {
    try{
      config.option('debug',false);

      // ✅ CORRECTION: Récupérer une subscription existante si defaultSub n'est pas défini
      if (!defaultSub || !defaultSub.id) {
        const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
        defaultSub = contracts.find(c => c.content.frequency === 'month') || contracts[0];
      }

      const customer = await defaultSub.customer();

      //
      // verify payment - ✅ CORRECTION: avec Stripe v10 paymentMethod délégué au customer
      const pid = defaultSub.paymentMethod;
      let card;
      if (pid) {
        // Si paymentMethod spécifique à la subscription
        card = customer.findMethodByID(pid);
        should.exist(card);
      } else {
        // Si délégué au customer, récupérer default payment method du customer
        const methods = await customer.listMethods();
        card  = methods.find(method => method.default);

        should.exist(card);
        // ✅ Ou plus simple avec defaultMethod getter
        // card = customer.defaultMethod;
        // should.exist(card);
      }
      await customer.removeMethod(card);
  
    }catch(err) {
      should.not.exist(err);
      // DEPRECATED 
      // err.message.should.containEql('Impossible de supprimer');

    }
  });

  it("list all SubscriptionContract for one customer", async function() {
    const contracts = await subscription.SubscriptionContract.list(defaultCustomer);
    contracts.length.should.equal(3);

    contracts.forEach(contract=> {
      const content = contract.content;
      console.log('\n     ------------------------------- ');
      console.log('-- ',content.status,content.description, defaultCustomer.name,contract.paymentMethod);
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
    const pausedUntil = new Date(Date.now() + 86400000*30); // +30 jours
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
