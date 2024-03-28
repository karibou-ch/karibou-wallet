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
 const card_authenticationRequired = require("../dist/payments").card_authenticationRequired;
 const card_visa_chargeDeclined = require("../dist/payments").card_visa_chargeDeclined;
 const card_visa_chargeDeclinedLostCard = require("../dist/payments").card_visa_chargeDeclinedLostCard;

 const transaction = require("../dist/transaction");
 const $stripe = require("../dist/payments").$stripe;
 const should = require('should');


describe("Class transaction.stripe.charge", function(){
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultTX;

  const paymentOpts = {
    charge: true,
    oid: '01234'
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

    //
    // valid US - 067c7f79097066667c6477516477767d 
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;

  });



  //
  // https://stripe.com/docs/automated-testing
  it("Transaction charge throw authenticationRequired", async function() {
    const tx = await transaction.Transaction.authorize(defaultCustomer,card_authenticationRequired,2,paymentOpts)
    tx.should.property("status");
    tx.status.should.equal("requires_action");
    tx.should.property("client_secret");
    tx.client_secret.should.containEql("pi_");
  });

  it("Transaction charge throw chargeDeclined", async function() {
    try{
      const tx = await transaction.Transaction.authorize(defaultCustomer,card_visa_chargeDeclined,2,paymentOpts)
      should.not.exist("dead zone");
    }catch(err){
      should.exist(err);
      err.message.should.containEql("La banque a refusé")
    }
  });


  it("Transaction create charge", async function() {

    // load card from default customer
    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    const tx = await transaction.Transaction.authorize(defaultCustomer,card,2,paymentOpts)
    tx.should.property("amount");
    tx.should.property("customer");
    tx.status.should.equal('paid');
    tx.authorized.should.equal(false);
    tx.amount.should.equal(2);
    tx.oid.should.equal('01234');
    tx.requiresAction.should.equal(false);
    tx.captured.should.equal(true);
    tx.canceled.should.equal(false);
    tx.refunded.should.equal(0);

    should.exist(tx.report.log);
    should.exist(tx.report.transaction);

    defaultTX = tx.id;
  });

  it("Transaction load charge and update status to prepaid", async function() {
    const tx = await transaction.Transaction.get(defaultTX);
    tx.authorized.should.equal(false);
    tx.amount.should.equal(2);
    tx.status.should.equal('paid');
    tx.oid.should.equal('01234');
    tx.requiresAction.should.equal(false);
    tx.captured.should.equal(true);
    tx.canceled.should.equal(false);
    tx.refunded.should.equal(0);
    should.exist(tx.report.log);
    should.exist(tx.report.transaction);

    await tx.updateStatusPrepaidFor('01234');
    // console.log('---- DBG report amount_capturable',tx._payment.amount_capturable);
    // console.log('---- DBG report amount_received',tx._payment.amount_received);

  });
  it("Transaction load prepaid charge", async function() {
    const tx = await transaction.Transaction.get(defaultTX);
    tx.authorized.should.equal(true);
    tx.amount.should.equal(2);
    tx.status.should.equal('prepaid');
    tx.oid.should.equal('01234');
    tx.requiresAction.should.equal(false);
    tx.captured.should.equal(false);
    tx.canceled.should.equal(false);
    tx.refunded.should.equal(0);
    should.exist(tx.report.log);
    should.exist(tx.report.transaction);

    // console.log('---- DBG report amount_capturable',tx._payment.amount_capturable);
    // console.log('---- DBG report amount_received',tx._payment.amount_received);
  });


  it("Transaction capture amount >2 fr throws an error (FIXME: 1cts round issue)", async function() {
    try{
      const tx = await transaction.Transaction.get(defaultTX);
      await tx.capture(2.02);
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql("the requested capture amount is greater");
      //err.message.should.containEql('he refund has exceeded the amount available');
    }
  });

  it("Transaction capture amount >1 fr should success (status is refunded)", async function() {
    const tx = await transaction.Transaction.get(defaultTX);
    //
    // capture is a simulation to simplify UX
    await tx.capture(1.0);
    tx.amount.should.equal(2);
    tx.refunded.should.equal(1);
    tx.status.should.equal('refunded');
    tx.authorized.should.equal(false);
    tx.captured.should.equal(true);
    tx.canceled.should.equal(false);
  });

  it("Transaction cancel a captured tx throw an error", async function() {
    try{
      const tx = await transaction.Transaction.get(defaultTX);
      await tx.cancel();
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Impossible to cancel captured transaction');
    }
  });

  it("Transaction total refund", async function() {
    const tx = await transaction.Transaction.get(defaultTX);
    await tx.refund();
    tx.refunded.should.equal(2);
    tx.amount.should.equal(2);
  });    
});
