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


describe("Class transaction with credit.balance mixed with Stripe (edge case)", function(){
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

  it("Create customer with 10 fr in credit balance", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.create("test@email.com","Foo","Bar","022345",1234);


    // 
    // testing credit with a limit
    await defaultCustomer.updateCredit(10);

    //
    // valid US - 067c7f79097066667c6477516477767d 
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;
  });




  it("Transaction create mixed payment credit plus prepaid visa", async function() {
    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const tx = await transaction.Transaction.authorize(defaultCustomer,card,20,paymentOpts)
    tx.amount.should.equal(20);
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(0);
    tx.status.should.equal("authorized");
    tx.provider.should.equal("stripe");
    tx.customerCredit.should.equal(10);
    defaultTX = tx;

    //
    // warning, Customer.get use cache
    let testing = await $stripe.customers.retrieve(unxor(defaultCustomer.id));
    testing.balance.should.equal(0);

  });



  it("Transaction capture amount 10 fr (maximum for credit)", async function() {
    try {
      const tx = await transaction.Transaction.get(defaultTX.id);
      const cmp = await tx.capture(10);
      tx.amount.should.equal(10);
      tx.refunded.should.eql(0);
      tx.status.should.equal("paid");
    } catch (err) {
      console.log(err.message);
      throw err;
    }

  });  


  
});
