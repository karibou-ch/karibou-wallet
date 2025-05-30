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


describe("Class transaction with negative customer credit", function(){
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

  it("Create customer with a small credit balance of 2 fr", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.create("test@email.com","Foo","Bar","022345",1234);
    // await defaultCustomer.updateCredit(2);

  });


  it("Transaction unauth credit throw an error", async function() {
    try{
      const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,4,paymentOpts)
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Le paiement par crédit n\'est pas disponible')
    }
  });  

  it("Update customer with credit balance", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.get(defaultCustomer.id);

    // 
    // testing negative credit
    const card = await defaultCustomer.allowCredit(true);

    should.exist(card);
    should.exist(card.alias);
    // defaultCustomer.balance.should.equal(2);

    defaultPaymentAlias = card.alias;
  });


  it("Transaction create with exceeded credit limit throw an error", async function() {
    try{
      const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,42.1,paymentOpts)
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Vous avez atteind la limite de crédit')
    }
  });  

  it("Transaction create with suffisant fund is ok", async function() {
    const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,10.05,paymentOpts);
    should.exist(tx);
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(-10.05)
    tx.provider.should.equal("invoice");
    tx.amount.should.equal(10.05);
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
    tx.amount.should.equal(10.05);
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
      await tx.capture(10.06);
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

  it("invoice Transaction capture partial create a bill of partial amount 4 of 10", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    // authqorize 10.05!
    defaultCustomer.balance.should.equal(-10.05);
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.capture(4.01);
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("invoice");
    defaultTX.amount.should.equal(4.01);
    defaultTX.customerCredit.should.equal(4.01);

    const cust = await customer.Customer.get(tx.customer);
    cust.balance.should.equal(-4.01);

  });

  xit("DEPRECATED capture tx marked as INVOICE with differ amount AS NO INCIDENCE", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    //
    // when bill is valided, the amount is the same as the captured amount
    defaultTX = await tx.capture(40.02);
    defaultTX.amount.should.equal(4.01);
    defaultTX.status.should.equal('invoice_paid');

    const cust = await customer.Customer.get(tx.customer);
    cust.balance.should.equal(-4.01);
  });


  xit("invoice_paid refund partial amount 1 of 4.01", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.refund(1.0);
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("invoice_paid");
    defaultTX.amount.should.equal(4.01);
    defaultTX.refunded.should.equal(1);
    const cust = await customer.Customer.get(tx.customer);
    cust.balance.should.equal(-3.01);
  });  

  it("final capture of invoice_paid  with amount differ from captured AS NO INCIDENCE", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    //
    // when bill is valided, the amount is the same as the captured amount
    defaultTX = await tx.capture(5.0); 
    defaultTX.amount.should.equal(4.01);
    defaultTX.status.should.equal('paid');

    const cust = await customer.Customer.get(tx.customer);
    cust.balance.should.equal(0);

  });


  it("invoice Transaction paid bill of aleady captured bill throw an error", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    try{
      const tx = await transaction.Transaction.fromOrder(orderPayment);
      defaultTX = await tx.capture(4.01);
    }catch(err){
      err.message.should.containEql('Transaction need to be authorized');
    }    

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

  it("invoice Transaction refund partial amount 1 of 4.01", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.provider
    }
    const tx = await transaction.Transaction.fromOrder(orderPayment);
    defaultTX = await tx.refund(1.0);
    defaultTX.provider.should.equal("invoice");
    defaultTX.status.should.equal("refunded");
    defaultTX.amount.should.equal(4.01);
    defaultTX.refunded.should.equal(1);
    const cust = await customer.Customer.get(tx.customer);
    cust.balance.should.equal(1);
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
    defaultTX.amount.should.equal(4.01);
    defaultTX.refunded.should.equal(4.01);
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

  it("Transaction user with credit available can create TX with his mastercard ", async function() {
    const tx = await transaction.Transaction.authorize(defaultCustomer,card_mastercard_prepaid,40.1,paymentOpts)
    should.exist(tx);
  });  

});
