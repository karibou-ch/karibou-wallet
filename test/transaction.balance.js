/**
 * Karibou payment wrapper
 * Customer
 */

const config =require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
const default_card_invoice = require("../dist/payments").default_card_invoice;
const transaction = require("../dist/transaction");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');
const axios = require('axios');
const { default: Config } = require("../dist/config");


describe("Class transaction with customer debit", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultTXtoRefund;
  let defaultTX;

  const paymentOpts = {
    oid: '01234',
    txgroup: 'AAA',
    shipping: {
        streetAdress: 'rue du rhone 69',
        postalCode: '1208',
        name: 'Credit balance testing family'
    }
  };


  before(function(done){
    done();
  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
  });

  it("Create customer with debit balance", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.create("test@email.com","Foo","Bar","022345",1234);

    //
    // valid US - 067c7f79097066667c6477516477767d 
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;
  });



  it("Transaction create with insuffisant fund throw an error", async function() {
    try{
      await defaultCustomer.updateCredit(10);
      const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,10.1,paymentOpts)
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Le paiement par crédit n\'est pas disponible')
    }
  });  

  it("Transaction create with suffisant fund is ok", async function() {
    const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,10,paymentOpts)
    should.exist(tx);
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(0)
    tx.provider.should.equal("invoice");
    tx.amount.should.equal(10);
    tx.status.should.equal("authorized");
    tx.authorized.should.equal(true);
    tx.group.should.equal('#01234');
    tx.oid.should.equal('01234');
    tx.requiresAction.should.equal(false);
    tx.captured.should.equal(false);
    tx.canceled.should.equal(false);
    tx.refunded.should.equal(0);
    should.not.exist(tx._payment.shipping);

    should.exist(tx.report.log);
    should.exist(tx.report.transaction);
    defaultTX = tx;
  });  


  it("invoice Transaction load from Order", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    tx.provider.should.equal("invoice");
    tx.amount.should.equal(10);
    tx.status.should.equal("authorized");
    tx.authorized.should.equal(true);
    tx.group.should.equal('#01234');
    tx.oid.should.equal('01234');
    tx.requiresAction.should.equal(false);
    tx.captured.should.equal(false);
    tx.canceled.should.equal(false);
    tx.refunded.should.equal(0);
    should.not.exist(tx._payment.shipping);

  });

  it("invoice Transaction capture amount >10 fr throws an error", async function() {
    try{
      // KngOrderPayment
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.capture(10.01);
      should.not.exist("dead zone");
    }catch(err) {
      //  requested capture amount is greater than the amount you can capture for this charge
      err.message.should.containEql('capture amount is greater than the');
    }
  });  

  it("invoice Transaction capture negative amount throws an error", async function() {
    try{
      // KngOrderPayment
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.capture(-1);
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('a null or positive amount to proceed');
    }
  });  


  it("invoice Transaction refund before capture or cancel throws an error", async function() {
    try{
      // KngOrderPayment
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      tx.provider.should.equal("invoice");
      await tx.refund();
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('refunded before capture');
    }
  });  


  it("invoice Transaction capture partial amount 4 of 10", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.capture(4.0);
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("paid");
    defaultTX.amount.should.equal(4);
    defaultTX.customerCredit.should.equal(4);
    defaultTX.refunded.should.equal(0);
  });

  it("invoice Transaction refund amount too large throw an error", async function() {
    try{
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.refund(7.0);
      should.not.exist("dead zone");

    }catch(err){
      err.message.should.containEql('The refund has exceeded the amount available');
    }
  });

  it("invoice Transaction refund partial amount 1 of 4", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.refund(1.0);
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("refunded");
    defaultTX.amount.should.equal(4);
    defaultTX.refunded.should.equal(1);
  });  


  it("invoice Transaction refund amount too large between refunds throw an error", async function() {
    try{
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.refund(3.1);
      should.not.exist("dead zone");

    }catch(err){
      //  requested capture amount is greater than the amount you can capture for this charge
      err.message.should.containEql('The refund has exceeded the amount available');
    }
  });  

  it("invoice Transaction refund all available amount 3 of 3", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.refund();
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("refunded");
    defaultTX.amount.should.equal(4);
    defaultTX.refunded.should.equal(4);
  });  

  it("invoice Transaction refund amount when amount eql 0 throw an error", async function() {
    try{
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.refund(0.1);
      should.not.exist("dead zone");

    }catch(err){
      err.message.should.containEql('The refund has exceeded the amount available');
    }
  });  

  it("invoice Transaction cancel after refund throw an error", async function() {
    try{
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.cancel();
      should.not.exist("dead zone");

    }catch(err){
      err.message.should.containEql('Impossible to cancel captured transaction');
    }
  });  
  
    

});
