/**
 * Karibou payment wrapper
 * Customer
 */

 const config =require("../dist/config").default;
 const options = require('../config-test');
 config.configure(options.payment);

 const customer = require("../dist/customer");
 const unxor = require("../dist/payments").unxor;
 const card_twint = require("../dist/payments").card_twint;
 const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;

 const transaction = require("../dist/transaction");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');


describe("Class transaction.twint", function(){
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
        name: 'foo bar family'
    }
  };


  before(function(done){
    done();
  });

  after(async function () {
    await $stripe.customers.del(unxor(defaultCustomer.id));
  });
  it("Create list of cards for testing transaction", async function(){
    config.option('debug',false);
    defaultCustomer = await customer.Customer.create("test@email.com","Foo","Bar","022345",1234);
  });



  it("Transaction create authorization", async function() {

    // load card from default customer
    const tx = await transaction.Transaction.authorize(defaultCustomer,card_twint,2,paymentOpts)
    tx.should.property("amount");
    tx.should.property("group");
    tx.should.property("customer");
    tx.authorized.should.equal(false);
    tx.amount.should.equal(2);
    tx.group.should.equal('AAA');
    tx.oid.should.equal('01234');
    tx.status.should.equal('requires_payment_method')
    tx.requiresAction.should.equal(false);
    tx.captured.should.equal(false);
    tx.canceled.should.equal(false);
    tx.refunded.should.equal(0);
    tx.paymentType.should.equal('twint');
    should.exist(tx._payment.shipping);

    should.exist(tx.report.log);
    should.exist(tx.report.transaction);

    defaultTX = tx;
  });

  it("Transaction load authorization and confirm it", async function() {
    const orderPayment = {
      status:defaultTX.status,
      transaction:defaultTX.id,
      issuer:defaultTX.paymentType
    }
    let tx = await transaction.Transaction.fromOrder(orderPayment);

    tx.paymentType.should.equal('twint');
    tx.authorized.should.equal(false);
    tx.amount.should.equal(2);
    tx.oid.should.equal('01234');
    tx.status.should.equal('requires_payment_method');
    tx.paymentType.should.equal('twint');

    tx = await transaction.Transaction.confirm(unxor(tx.id));
    //console.log(tx);
          //   // Simulate confirming the payment intent
          //   const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, {
          //     payment_method: 'pm_twint', // Utilisez un ID de méthode de paiement valide
          // });
  });


});
