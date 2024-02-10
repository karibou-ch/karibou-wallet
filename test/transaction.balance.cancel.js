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


describe("Cancel transaction with customer debit (CANCEL)", function(){
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
    await defaultCustomer.updateCredit(10);
});



  it("Transaction cancel authorize is ok", async function() {
    const tx = await transaction.Transaction.authorize(defaultCustomer,default_card_invoice,10,paymentOpts)
    should.exist(tx);
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(0)
    const canceld = await tx.cancel();
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(10)

  });  


    

});
