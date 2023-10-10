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
 const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
 const subscription = require("../dist/contract.subscription");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');
 const cartItems = require('./fixtures/cart.items');
 const { Webhook,WebhookContent } = require("../dist/webhook");
const { round1cts } = require("../dist/payments");


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
  let dateValidNow = new Date(Date.now() + 60000);
  let dateValid7d = new Date(Date.now() + 86400000*7);
 
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
  it("SubscriptionContract create initial weekly", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    //(initial) item[0] => 1000013,Panier, 7 
    //(updated) item[1] => 1000014, Bouquet, 7.25
    const item = cartItems.filter(item => item.frequency == "week")[0];


    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const subOptions = { shipping,dayOfWeek,fees };

    // IMPORTANT
    // a contract with a valid date for X days has a success payment, 
    // but  incomplete status until the first day 
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",dateValidNow,[item],subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");

  });

  // Simple weekly souscription 
  it("SubscriptionContract update throw invalid item", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.slice();
    try{
      const subOptions = { shipping,dayOfWeek,fees };
      const contract = await subscription.SubscriptionContract.get(defaultSub.id)
      defaultSub = await contract.update(items,subOptions);
      throw "error";
    }catch(err){
      err.message.should.containEql('incorrect item format')
    }

  });  


  // Simple weekly souscription 
  it("SubscriptionContract update throw invalid shipping", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    const items = cartItems.slice();
    try{
      const subOptions = { dayOfWeek,fees };
      const contract = await subscription.SubscriptionContract.get(defaultSub.id)
      defaultSub = await contract.update(items,subOptions);
      throw "error";
    }catch(err){
      err.message.should.containEql('Shipping address is mandatory')
    }
  });  

  // Simple weekly souscription 
  it("SubscriptionContract update fees,shipping and dayOfWeek", async function() {
    const fees = 0.07;
    const dayOfWeek= 4; // tuesday
    config.option('debug',true);

    // items are empty
    const items = [];
    const newShippingfees  = Object.assign({},shipping);
    newShippingfees.price = 8;

    const contract = await subscription.SubscriptionContract.get(defaultSub.id)
    const previousItems = contract.content.items;
    const subOptions = { shipping:newShippingfees,dayOfWeek,fees };
    defaultSub = await contract.update([],subOptions)
    defaultSub.should.property("content");
    defaultSub.content.items.length.should.equal(previousItems.length);

    const amount = defaultSub.content.items.reduce((sum,item) => (item.fees*item.quantity)+sum,0)

    const KF = defaultSub.content.services.find(service => service.title =='karibou.ch')
    KF.fees.should.equal(round1cts(amount*fees))
    const SH = defaultSub.content.services.find(service => service.title =='shipping')
    SH.fees.should.equal(8);
    defaultSub.content.dayOfWeek.should.equal(dayOfWeek)
  });


  it("SubscriptionContract update only with add/delete items", async function() {
    const fees = 0.07;
    const dayOfWeek= 4; // tuesday
    config.option('debug',true);

    const newShippingfees  = Object.assign({},shipping);
    newShippingfees.price = 8;

    const contract = await subscription.SubscriptionContract.get(defaultSub.id)
    const previousItems = contract.content.items;

    const subOptions = { shipping:newShippingfees,dayOfWeek,fees };

    //(initial) item[0] => 1000013,Panier, 7 
    //(updated) item[1] => 1000014, Bouquet, 7.25
    const items = cartItems.filter(item => item.frequency == "week").map(item => Object.assign({},item));
    items[0].deleted=true;

    defaultSub = await contract.update(items,subOptions)
    defaultSub.should.property("content");
    defaultSub.content.items.length.should.equal(1);
    defaultSub.content.items[0].sku.should.equal('1000014')
    const amount = defaultSub.content.items.reduce((sum,item) => (item.fees*item.quantity)+sum,0)

    const KF = defaultSub.content.services.find(service => service.title =='karibou.ch')
    KF.fees.should.equal(round1cts(amount*fees))
    const SH = defaultSub.content.services.find(service => service.title =='shipping')
    SH.fees.should.equal(8);
    defaultSub.content.dayOfWeek.should.equal(dayOfWeek)
  });

  it("SubscriptionContract update only with updated items", async function() {
    const fees = 0.07;
    const dayOfWeek= 4; // tuesday
    // config.option('debug',true);

    const newShippingfees  = Object.assign({},shipping);
    newShippingfees.price = 8;

    const contract = await subscription.SubscriptionContract.get(defaultSub.id)

    const subOptions = { shipping:newShippingfees,dayOfWeek,fees };

    //(initial) item[0] => 1000013,Panier, 7 
    //(updated) item[1] => 1000014, Bouquet, 7.25
    const items = cartItems.filter(item => item.frequency == "week").map(item => Object.assign({},item));;
    items[1].price=14;
    defaultSub = await contract.update(items,subOptions)
    defaultSub.should.property("content");
    defaultSub.content.items.length.should.equal(2);
    defaultSub.content.items[0].sku.should.equal('1000014');
    defaultSub.content.items[0].fees.should.equal(14);
    defaultSub.content.items[0].unit_amount.should.equal(1400);
    const amount = defaultSub.content.items.reduce((sum,item) => (item.fees*item.quantity)+sum,0)

    const KF = defaultSub.content.services.find(service => service.title =='karibou.ch')
    KF.fees.should.equal(round1cts(amount*fees))
    const SH = defaultSub.content.services.find(service => service.title =='shipping')
    SH.fees.should.equal(8);
    defaultSub.content.dayOfWeek.should.equal(dayOfWeek)
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
