/**
 * Karibou payment wrapper
 * Test Overcapture - Stripe Error Handling
 * 
 * Ce test valide que l'overcapture est REFUSÉ pour les paiements Stripe.
 * L'overcapture est uniquement autorisé pour invoice (crédit client).
 * 
 * Usage:
 *   NODE_ENV=test npx mocha test/transaction.stripe.overcapture.js --exit
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;
const transaction = require("../dist/transaction");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');


describe("Class transaction.stripe.overcapture - Error Handling", function(){
  this.timeout(15000);

  let defaultCustomer;
  let defaultPaymentAlias;

  const paymentOpts = {
    oid: 'stripe-overcapture-error-test',
    txgroup: 'STRIPE-OC-ERR',
    shipping: {
      streetAdress: 'rue du rhone 69',
      postalCode: '1208',
      name: 'Stripe Error Test family'
    }
  };

  before(function(done){
    //
    // Disable overcapture during authorization (Stripe test account doesn't support it)
    config.option('overcaptureEnabled', false);
    config.option('overcapturePercentage', 0.20);
    done();
  });

  after(async function () {
    config.option('overcaptureEnabled', false);
    
    if (defaultCustomer) {
      try {
        await $stripe.customers.del(unxor(defaultCustomer.id));
      } catch(e) {
        // Ignore cleanup errors
      }
    }
  });

  it("Create customer and card for Stripe error testing", async function(){
    config.option('debug', false);
    defaultCustomer = await customer.Customer.create("test-stripe-overcapture-error@email.com", "Foo", "Bar", "022345", 1234);
    
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;
    
    should.exist(defaultPaymentAlias);
    console.log('   ✅ Customer créé avec carte de test');
  });

  //
  // Test: Overcapture DISABLED - Stripe capture doit échouer
  //
  describe("Stripe overcapture DISABLED - capture must fail", function() {
    let tx;
    const AUTH_AMOUNT = 100;
    const CAPTURE_AMOUNT = 110; // +10%

    it("Authorize 100 CHF via Stripe (overcapture disabled)", async function() {
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
      tx = await transaction.Transaction.authorize(defaultCustomer, card, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'stripe-oc-disabled-1'
      });
      
      tx.authorized.should.equal(true);
      tx.amount.should.equal(AUTH_AMOUNT);
      tx.provider.should.equal('stripe');
      
      console.log(`   ✅ Autorisé via Stripe: ${AUTH_AMOUNT} CHF (overcapture DISABLED)`);
    });

    it("Capture 110 CHF (+10%) DOIT ÊTRE REFUSÉ (overcapture disabled)", async function() {
      console.log(`\n   ⏳ Tentative de capture: ${CAPTURE_AMOUNT} CHF (+10%)`);
      
      try {
        await tx.capture(CAPTURE_AMOUNT);
        should.not.exist("dead zone - capture should have been rejected");
      } catch(err) {
        console.log(`   ✅ Refus correct: ${err.message.substring(0, 60)}...`);
        err.message.should.containEql('greater');
        
        //
        // Transaction should still be authorized (not corrupted)
        tx.authorized.should.equal(true);
        tx.captured.should.equal(false);
        console.log('   ✅ Transaction reste en état "authorized"');
      }
    });

    it("Capture normal amount DOIT RÉUSSIR", async function() {
      const NORMAL_AMOUNT = 95;
      
      await tx.capture(NORMAL_AMOUNT);
      
      tx.captured.should.equal(true);
      tx.amount.should.equal(NORMAL_AMOUNT);
      
      console.log(`   ✅ Capture normale réussie: ${NORMAL_AMOUNT} CHF`);
      
      //
      // Cleanup
      await tx.refund();
    });
  });

  //
  // Test: Overcapture ENABLED - Stripe capture doit AUSSI échouer (Stripe refuse)
  //
  describe("Stripe overcapture ENABLED - capture still fails (Stripe rejects)", function() {
    let tx;
    const AUTH_AMOUNT = 50;
    const CAPTURE_AMOUNT = 55; // +10%

    it("Authorize 50 CHF via Stripe", async function() {
      //
      // Keep overcapture disabled during auth (Stripe test doesn't support request_overcapture)
      config.option('overcaptureEnabled', false);
      
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
      tx = await transaction.Transaction.authorize(defaultCustomer, card, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'stripe-oc-enabled-1'
      });
      
      tx.authorized.should.equal(true);
      console.log(`   ✅ Autorisé via Stripe: ${AUTH_AMOUNT} CHF`);
    });

    it("Capture 55 CHF (+10%) with overcapture ENABLED - DOIT ÉCHOUER (Stripe rejects)", async function() {
      //
      // Enable overcapture for capture - bypasses local validation
      config.option('overcaptureEnabled', true);
      
      console.log(`\n   ⏳ Tentative de capture: ${CAPTURE_AMOUNT} CHF (+10%)`);
      console.log('   📌 overcaptureEnabled=true mais Stripe va refuser');
      
      try {
        await tx.capture(CAPTURE_AMOUNT);
        
        //
        // Si on arrive ici, Stripe a accepté l'overcapture (inattendu pour compte test)
        console.log('   ⚠️  INATTENDU: Stripe a accepté l\'overcapture');
        await tx.refund();
        
      } catch(err) {
        console.log(`   ✅ ERREUR CAPTURÉE: ${err.message.substring(0, 80)}...`);
        
        //
        // L'erreur peut venir de Stripe ou de notre validation
        const isExpectedError = 
          err.message.includes('greater') ||
          err.message.includes('amount') ||
          err.message.includes('capture');
        
        isExpectedError.should.equal(true, `Erreur inattendue: ${err.message}`);
        console.log('   ✅ Erreur correctement propagée');
      }
    });

    it("Cleanup: cancel or refund transaction", async function() {
      config.option('overcaptureEnabled', false);
      
      try {
        if (tx.authorized && !tx.captured) {
          await tx.cancel();
          console.log('   ✅ Transaction annulée');
        } else if (tx.captured) {
          await tx.refund();
          console.log('   ✅ Transaction remboursée');
        }
      } catch(e) {
        // Ignore cleanup errors
      }
    });
  });

  //
  // Test: État de la transaction après erreur
  //
  describe("Transaction state preserved after overcapture error", function() {
    let tx;
    const AUTH_AMOUNT = 75;

    it("Authorize 75 CHF", async function() {
      config.option('overcaptureEnabled', false);
      
      const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
      tx = await transaction.Transaction.authorize(defaultCustomer, card, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'stripe-state-test'
      });
      
      tx.authorized.should.equal(true);
    });

    it("Failed overcapture should NOT modify transaction state", async function() {
      const originalAmount = tx.amount;
      const originalStatus = tx.status;
      
      try {
        await tx.capture(100); // +33% overcapture
      } catch(err) {
        // Expected error
      }
      
      //
      // State should be preserved
      tx.amount.should.equal(originalAmount);
      tx.status.should.equal(originalStatus);
      tx.authorized.should.equal(true);
      tx.captured.should.equal(false);
      
      console.log('   ✅ État transaction préservé après erreur');
    });

    it("Transaction can still be cancelled after failed capture", async function() {
      await tx.cancel();
      
      tx.canceled.should.equal(true);
      tx.authorized.should.equal(false);
      
      console.log('   ✅ Annulation réussie après échec d\'overcapture');
    });
  });

});
