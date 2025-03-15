/**
 * Karibou payment wrapper
 * Customer
 */

const config =require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const default_card_invoice = require("../dist/payments").default_card_invoice;
const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
const transaction = require("../dist/transaction");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');
const axios = require('axios');


describe("Class transaction with mixed positive customer credit", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
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

  it("Create customer with a small credit balance of 10 fr", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.create("test@email.com","Foo","Bar","022345",1234);
    await defaultCustomer.updateCredit(10);

  });


  it("Update customer with credit balance", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.get(defaultCustomer.id);

    // 
    // testing negative credit
    const card = await defaultCustomer.allowCredit(true);

    should.exist(card);
    should.exist(card.alias);
    defaultCustomer.balance.should.equal(10);

    defaultPaymentAlias = card.alias;
  });



  it("Transaction create with suffisant fund is ok", async function() {
    const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,5.05,paymentOpts);
    should.exist(tx);
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(4.95)
    tx.provider.should.equal("invoice");
    tx.amount.should.equal(5.05);
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
    tx.amount.should.equal(5.05);
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

  it("invoice Transaction capture amount >5.06 fr throws an error", async function() {
    try{
      // KngOrderPayment
      const orderPayment = {
        status:defaultTX.status,
        transaction:defaultTX.id,
        issuer:defaultTX.provider
      }
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      await tx.capture(5.06);
      should.not.exist("dead zone");
    }catch(err) {
      //  requested capture amount is greater than the amount you can capture for this charge
      err.message.should.containEql('capture amount is greater than the');
    }
  });  

  it("invoice Transaction capture partial create a bill of partial amount 4 of 5", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.capture(4.05);
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("paid");
    defaultTX.amount.should.equal(4.05);
    defaultTX.refunded.should.equal(0);
    defaultTX.customerCredit.should.equal(4.05);

    const cust = await customer.Customer.get(tx.customer);
    cust.balance.should.equal(5.95)

  });

  it("Transaction refound amount 1 fr", async function() {
    // config.option('debug',true);

    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.refund(1);
    defaultTX.amount.should.eql(4.05);
    defaultTX.refunded.should.eql(1);
    defaultTX.status.should.eql("refunded");

    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(6.95);
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
      defaultTX = await tx.refund();
      defaultTX.amount.should.eql(4.05);
      defaultTX.refunded.should.eql(4.05);
      defaultTX.status.should.eql("refunded");
  
      defaultCustomer = await customer.Customer.get(tx.customer);
      defaultCustomer.balance.should.equal(10);
  
    }catch(err) {
      err.message.should.containEql('refunded before capture');
    }
  });  
});
