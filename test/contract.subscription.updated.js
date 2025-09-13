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

describe("Class subscription.updated", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultSub;
  let defaultTx;

  // ✅ FIX Bug 2: Fonctions pour dates fraîches (pas de variables globales obsolètes)
  const getDateValidNow = () => new Date(Date.now() + 60000);
  const getDateValid7d = () => new Date(Date.now() + 86400000*7);
 
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
    defaultSub = await subscription.SubscriptionContract.create(defaultCustomer,card,"week",getDateValidNow(),[item],subOptions)

    defaultSub.should.property("id");
    defaultSub.should.property("content");
    defaultSub.content.status.should.equal("active");
    should.not.exist(defaultSub.content.shipping.price);

  });

  // Simple weekly souscription 
  it("SubscriptionContract update throw invalid item", async function() {

    const fees = 0.06;
    const dayOfWeek= 2; // tuesday
    // ✅ FIX Bug 3: Utiliser l'item EXACT de l'abonnement mais avec frequency incorrecte
    // On récupère l'item qui existe déjà dans defaultSub pour que findOneItem() le trouve
    const existingItem = defaultSub.content.items[0]; // Item qui existe dans l'abonnement
    const badItem = {
      sku: existingItem.sku,          // ✅ Même SKU (findOneItem trouvera available)
      frequency: "month",             // ❌ frequency incorrecte → "incorrect item format"
      price: existingItem.price,
      title: existingItem.title,
      quantity: existingItem.quantity
    };
    const items = [badItem];
    try{
      const subOptions = { shipping,dayOfWeek,fees };
      const contract = await subscription.SubscriptionContract.get(defaultSub.id)
      defaultSub = await contract.update(items,subOptions);
      throw "error";
    }catch(err){
      // ✅ FIX Bug 3: Avec le bon SKU, on obtient maintenant "incorrect item format"
      err.message.should.containEql('incorrect item format')
    }

  });  


  // Simple weekly souscription 

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
    should.exist(KF);
    KF.fees.should.equal(round1cts(amount*fees))
    const SH = defaultSub.content.services.find(service => service.title =='shipping')
    should.exist(SH);
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

  it("SubscriptionContract update only shipping address and cost", async function() {
    const fees = 0.07;
    const dayOfWeek = 4; // tuesday
    // config.option('debug',true);

    const contract = await subscription.SubscriptionContract.get(defaultSub.id)
    const previousItems = contract.content.items;
    const previousServiceFees = contract.content.services.find(service => service.title =='karibou.ch').fees;

    // Only change the shipping address and price
    const newExpensiveShipping = {
      streetAdress: 'avenue de la Paix 15',
      postalCode: '1202', 
      name: 'New expensive delivery location',
      price: 12, // More expensive delivery
      hours: 18,
      lat: 46.2044,
      lng: 6.1432
    };

    const subOptions = { shipping: newExpensiveShipping, dayOfWeek, fees };

    // Keep items empty to maintain existing items
    defaultSub = await contract.update([], subOptions);
    
    defaultSub.should.property("content");
    // Items should remain the same
    defaultSub.content.items.length.should.equal(previousItems.length);
    defaultSub.content.items.forEach((item, index) => {
      item.sku.should.equal(previousItems[index].sku);
      item.fees.should.equal(previousItems[index].fees);
    });

    // Service fees should remain the same (calculated on same items)
    const KF = defaultSub.content.services.find(service => service.title =='karibou.ch');
    KF.fees.should.equal(previousServiceFees);
    
    // Only shipping cost should change
    const SH = defaultSub.content.services.find(service => service.title =='shipping');
    SH.fees.should.equal(12);
    
    // Shipping address should be updated in metadata
    defaultSub.content.shipping.streetAdress.should.equal('avenue de la Paix 15');
    defaultSub.content.shipping.postalCode.should.equal('1202');
    defaultSub.content.shipping.name.should.equal('New expensive delivery location');
    
    // Other contract parameters should remain unchanged
    defaultSub.content.dayOfWeek.should.equal(dayOfWeek);
    defaultSub.content.frequency.should.equal('week');
  });

  it("SubscriptionContract add new product to existing contract", async function() {
    const fees = 0.07;
    const dayOfWeek = 4; // tuesday
    // config.option('debug',true);

    const contract = await subscription.SubscriptionContract.get(defaultSub.id)
    const previousItems = contract.content.items;

    const newShipping = {
      streetAdress: 'avenue de la Paix 15',
      postalCode: '1202', 
      name: 'New expensive delivery location',
      price: 12,
      hours: 18,
      lat: 46.2044,
      lng: 6.1432
    };

    const subOptions = { shipping: newShipping, dayOfWeek, fees };

    // Add a completely new product to the existing contract
    const newProduct = {
      frequency: "week",
      timestamp: Date.now(),
      hub: 'mocha',
      sku: '1000015', // New SKU not in the existing contract
      title: "Nouveau produit ajouté",
      quantity: 1,
      part: "1kg",
      note: "produit frais",
      price: 15,
      finalprice: 15,
    };

    // Include existing items + new product
    const existingItems = previousItems.map(item => ({
      frequency: "week",
      sku: item.sku,
      title: item.title,
      quantity: item.quantity,
      part: item.part,
      note: item.note,
      price: item.fees,
      finalprice: item.fees,
      hub: item.hub
    }));

    const allItems = [...existingItems, newProduct];

    defaultSub = await contract.update(allItems, subOptions);
    
    defaultSub.should.property("content");
    
    // Should have previous items + new item
    defaultSub.content.items.length.should.equal(previousItems.length + 1);
    
    // Check that new product was added
    const addedProduct = defaultSub.content.items.find(item => item.sku === '1000015');
    addedProduct.should.not.be.undefined();
    addedProduct.title.should.equal("Nouveau produit ajouté");
    addedProduct.fees.should.equal(15);
    addedProduct.quantity.should.equal(1);
    
    // Check that existing items are still there
    previousItems.forEach(prevItem => {
      const existingItem = defaultSub.content.items.find(item => item.sku === prevItem.sku);
      existingItem.should.not.be.undefined();
    });

    // Service fees should be recalculated including the new product
    const totalAmount = defaultSub.content.items.reduce((sum,item) => (item.fees*item.quantity)+sum,0);
    const KF = defaultSub.content.services.find(service => service.title =='karibou.ch');
    KF.fees.should.equal(round1cts(totalAmount*fees));
    
    // Shipping should remain the same
    const SH = defaultSub.content.services.find(service => service.title =='shipping');
    SH.fees.should.equal(12);
  });

  it("SubscriptionContract update without specifying shipping or dayOfWeek", async function() {
    const newFees = 0.08; // Only change fees
    // config.option('debug',true);

    const contract = await subscription.SubscriptionContract.get(defaultSub.id)
    const previousItems = contract.content.items;
    const previousShipping = contract.content.shipping;
    const previousDayOfWeek = contract.content.dayOfWeek;
    const previousShippingCost = contract.content.services.find(service => service.title =='shipping').fees;

    // Update with minimal options - no shipping, no dayOfWeek specified
    const minimalOptions = { fees: newFees };

    defaultSub = await contract.update([], minimalOptions);
    
    defaultSub.should.property("content");
    
    // Items should remain the same
    defaultSub.content.items.length.should.equal(previousItems.length);
    defaultSub.content.items.forEach((item, index) => {
      item.sku.should.equal(previousItems[index].sku);
      item.fees.should.equal(previousItems[index].fees);
    });

    // Shipping address should remain exactly the same
    defaultSub.content.shipping.streetAdress.should.equal(previousShipping.streetAdress);
    defaultSub.content.shipping.postalCode.should.equal(previousShipping.postalCode);
    defaultSub.content.shipping.name.should.equal(previousShipping.name);
    defaultSub.content.shipping.lat.should.equal(previousShipping.lat);
    defaultSub.content.shipping.lng.should.equal(previousShipping.lng);
    
    // dayOfWeek should remain the same
    defaultSub.content.dayOfWeek.should.equal(previousDayOfWeek);
    
    // Shipping cost should remain the same (not recalculated)
    const SH = defaultSub.content.services.find(service => service.title =='shipping');
    should.exist(SH);
    SH.fees.should.equal(previousShippingCost);
    
    // Only service fees should change due to new fee percentage
    const totalAmount = defaultSub.content.items.reduce((sum,item) => (item.fees*item.quantity)+sum,0);
    const KF = defaultSub.content.services.find(service => service.title =='karibou.ch');
    should.exist(KF);
    KF.fees.should.equal(round1cts(totalAmount*newFees));
    
    // Contract frequency should remain unchanged
    defaultSub.content.frequency.should.equal('week');
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
        console.log('   ',item.title,item.sku,item.quantity * (item.unit_amount/100), 'chf for',item.quantity,'items');
      })
      console.log('-- services ');
      content.services.forEach(service=> {
        console.log('   ',service.id, 'chf',service.fees);
      })

    });

  });
});
