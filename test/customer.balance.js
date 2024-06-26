/**
 * Karibou payment wrapper
 * Customer
 */

const config =require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const payments = require("../dist/payments").Payment;
const unxor = require("../dist/payments").unxor;
const $stripe = require("../dist/payments").$stripe;
const should = require('should');


describe("customer.balance", function(){
  this.timeout(8000);

  const custCleanList = [];

  before(function(done){
    done()
  });

  after(async function () {    
    for (let cust of custCleanList) {
      await $stripe.customers.del(unxor(cust));
    }
  });

  // START TESTING
  it("stripe service should exist", async function() {
    should.exist($stripe);
    config.option('debug',false);
  });


  it("Construction of the customer", async function() {
    const cust = await customer.Customer.create("test@email.com","Foo","Bar","022345",1234);
    should.exist(cust);
    custCleanList.push(cust.id);
    cust.should.property('balance');
    cust.balance.should.equal(0);
  });


  it("Add negative credit throw an exception", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    try{
      await cust.updateCredit(-1);      
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Le paiement par crédit n\'est pas disponible');
    }
  });

  it("Authorize customer credit", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    await cust.allowCredit(true);
    should.exist(cust);
    cust.methods.some(method => method.issuer == 'invoice').should.equal(true);
    cust.allowedCredit().should.equal(true);
  });


  it("check payments methods ", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    const checks = await cust.checkMethods();
    cust.methods.forEach(method => {
      should.exist(checks[method.alias]);
      should.exist(checks[method.alias].expiry);
      checks[method.alias].expiry.should.equal(method.expiry);
    })
    checks.intent.should.equal(false);
  });

    

  it("Add max credit throw an exception", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    try{
      await cust.updateCredit(40.1);      
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Vous avez atteind la limite de votre portefeuille');
    }
  });

  it("update 0 amount credit", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    let testing;
    try{
      cust.balance.should.equal(0);
      await cust.updateCredit(0);      
      testing = await $stripe.customers.retrieve(unxor(cust.id));
      testing.balance.should.equal(0);
    }catch(err) {
      should.not.exist(err);
    }
  });


  it("Add authorized credit is ok", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    let testing;
    try{
      cust.balance.should.equal(0);
      await cust.updateCredit(35);      
      await cust.updateCredit(5);      
      testing = await $stripe.customers.retrieve(unxor(cust.id));
      testing.balance.should.equal(4000);

      cust.balance.should.equal(40);
      await cust.updateCredit(-40);      
      await cust.updateCredit(40);      
      cust.balance.should.equal(40);

      testing = await $stripe.customers.retrieve(unxor(cust.id));
      testing.balance.should.equal(4000);
    }catch(err) {
      console.log(err)
      should.not.exist(err);
    }
  });


  it("Add max credit throw an exception", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    try{
      await cust.updateCredit(0.1);      
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Vous avez atteind la limite de votre portefeuille');
    }
  });

  it("Add max negative credit throw an exception", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    try{
      await cust.updateCredit(-80.1);      
      should.not.exist("dead zone");
    }catch(err) {
      err.message.should.containEql('Vous avez atteind la limite de crédit de votre compte');
    }
  });

  it("Remove credit", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    await cust.updateCredit(-40);      
    cust.balance.should.eql(0)

    let testing = await $stripe.customers.retrieve(unxor(cust.id));
    testing.balance.should.equal(0);

  });

  it("Unauthorize customer credit", async function() {
    const cust = await customer.Customer.get(custCleanList[0]);
    await cust.allowCredit(false);
    cust.allowedCredit().should.equal(false);
    cust.balance.should.eql(0)

    let testing = await $stripe.customers.retrieve(unxor(cust.id));
    testing.balance.should.equal(0);

  });

});
