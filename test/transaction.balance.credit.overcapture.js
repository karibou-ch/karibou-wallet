/**
 * Karibou payment wrapper
 * Test Overcapture - 100% Invoice (Customer Credit)
 * 
 * Ce test valide l'overcapture pour les paiements par crédit client (invoice).
 * Contrairement à Stripe, l'overcapture invoice est géré localement.
 * 
 * Usage:
 *   NODE_ENV=test npx mocha test/transaction.balance.credit.overcapture.js --exit
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const default_card_invoice = require("../dist/payments").default_card_invoice;
const transaction = require("../dist/transaction");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');


describe("Class transaction.overcapture (100% Invoice/Credit)", function(){
  this.timeout(10000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let originalAllowMaxCredit;

  const paymentOpts = {
    oid: 'invoice-overcapture-test',
    txgroup: 'INVOICE-OC',
    shipping: {
      streetAdress: 'rue du rhone 69',
      postalCode: '1208',
      name: 'Invoice Overcapture family'
    }
  };

  before(function(done){
    //
    // Force overcapture enabled for INVOICE tests (separate from Stripe)
    config.option('overcaptureInvoiceEnabled', true);
    config.option('overcapturePercentage', 0.20);
    
    //
    // Increase credit limit for tests (allowMaxCredit/100 = max credit)
    // Set to 50000 = 500 CHF max credit
    originalAllowMaxCredit = config.option('allowMaxCredit');
    config.option('allowMaxCredit', 50000);
    done();
  });

  after(async function () {
    //
    // Reset overcapture config
    config.option('overcaptureInvoiceEnabled', false);
    config.option('allowMaxCredit', originalAllowMaxCredit);
    
    //
    // Cleanup customer
    if (defaultCustomer) {
      await $stripe.customers.del(unxor(defaultCustomer.id));
    }
  });

  it("Create customer and enable credit for overcapture testing", async function(){
    config.option('debug', false);
    defaultCustomer = await customer.Customer.create("test-invoice-overcapture@email.com", "Foo", "Bar", "022345", 1234);
    
    //
    // Enable credit
    const card = await defaultCustomer.allowCredit(true);
    should.exist(card);
    should.exist(card.alias);
    defaultPaymentAlias = card.alias;
    
    //
    // Verify credit is enabled (allowedCredit is a method)
    defaultCustomer = await customer.Customer.get(defaultCustomer.id);
    defaultCustomer.allowedCredit().should.equal(true);
  });

  //
  // Test: Vérifier que overcapture invoice est activé (séparé de Stripe)
  //
  describe("Configuration overcapture", function() {
    
    it("overcaptureInvoiceEnabled should be true (enabled in before())", function() {
      const enabled = config.option('overcaptureInvoiceEnabled');
      enabled.should.equal(true);
      console.log('   ✅ overcaptureInvoiceEnabled = true (for this test suite)');
    });

    it("overcaptureEnabled should be false (Stripe disabled)", function() {
      const enabled = config.option('overcaptureEnabled');
      enabled.should.equal(false);
      console.log('   ✅ overcaptureEnabled = false (Stripe disabled)');
    });

    it("overcapturePercentage should be 0.20 (20%)", function() {
      const percentage = config.option('overcapturePercentage');
      percentage.should.equal(0.20);
      console.log('   ✅ overcapturePercentage = 20%');
    });
  });

  //
  // Test: Capture normale (sans overcapture) - avec vérification complète du balance
  //
  describe("Invoice capture normale (sans overcapture)", function() {
    let tx;
    let balanceBeforeAuth;
    let balanceAfterAuth;
    let balanceAfterCapture;
    const AUTH_AMOUNT = 50;
    const CAPTURE_AMOUNT = 45;
    const REFUND_AMOUNT = AUTH_AMOUNT - CAPTURE_AMOUNT; // 5 CHF remboursé

    it("BEFORE AUTH: balance should be 0", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceBeforeAuth = defaultCustomer.balance;
      
      balanceBeforeAuth.should.equal(0);
      console.log(`   ✅ Balance AVANT auth: ${balanceBeforeAuth} CHF`);
    });

    it("Authorize 50 CHF via invoice", async function() {
      tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'invoice-normal-capture'
      });
      
      tx.authorized.should.equal(true);
      tx.amount.should.equal(AUTH_AMOUNT);
      tx.provider.should.equal('invoice');
      tx.customerCredit.should.equal(AUTH_AMOUNT);
      tx.creditNote.should.equal(0);
      tx.report.credit_note.should.equal(0);
    });

    it("AFTER AUTH: balance should be -50 CHF (blocked)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterAuth = defaultCustomer.balance;
      
      balanceAfterAuth.should.equal(-AUTH_AMOUNT);
      console.log(`   ✅ Balance APRÈS auth: ${balanceAfterAuth} CHF (bloqué: ${AUTH_AMOUNT} CHF)`);
    });

    it("Capture 45 CHF (partielle normale)", async function() {
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      await loadedTx.capture(CAPTURE_AMOUNT);
      
      loadedTx.captured.should.equal(true);
      loadedTx.amount.should.equal(CAPTURE_AMOUNT);
    });

    it("AFTER CAPTURE: balance should be -45 CHF (5 CHF refunded)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterCapture = defaultCustomer.balance;
      
      //
      // Le crédit final doit être -CAPTURE_AMOUNT (-45 CHF)
      balanceAfterCapture.should.equal(-CAPTURE_AMOUNT);
      
      //
      // Vérifier le montant remboursé
      const actualRefund = Math.abs(balanceAfterAuth) - Math.abs(balanceAfterCapture);
      actualRefund.should.equal(REFUND_AMOUNT);
      
      console.log(`   ✅ Balance APRÈS capture: ${balanceAfterCapture} CHF`);
      console.log(`   ✅ Montant remboursé: ${REFUND_AMOUNT} CHF`);
      console.log(`   📊 Résumé: 0 → -${AUTH_AMOUNT} (auth) → -${CAPTURE_AMOUNT} (capture partielle)`);
    });
  });

  //
  // Test: Overcapture +15% (doit réussir) - avec vérification complète du balance
  //
  describe("Invoice overcapture +15% (doit réussir)", function() {
    let tx;
    let balanceBeforeAuth;
    let balanceAfterAuth;
    let balanceAfterCapture;
    const AUTH_AMOUNT = 100;
    const CAPTURE_AMOUNT = 115; // +15%
    const OVERCAPTURE_DELTA = CAPTURE_AMOUNT - AUTH_AMOUNT; // 15 CHF

    before(async function() {
      //
      // Reset customer balance (credit back to 0)
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      if (defaultCustomer.balance !== 0) {
        await defaultCustomer.updateCredit(-defaultCustomer.balance, 'reset-for-overcapture-test');
        defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      }
    });

    it("BEFORE AUTH: balance should be 0", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceBeforeAuth = defaultCustomer.balance;
      
      balanceBeforeAuth.should.equal(0);
      console.log(`   ✅ Balance AVANT auth: ${balanceBeforeAuth} CHF`);
    });

    it("Authorize 100 CHF via invoice", async function() {
      tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'invoice-overcapture-15pct'
      });
      
      tx.authorized.should.equal(true);
      tx.amount.should.equal(AUTH_AMOUNT);
      tx.provider.should.equal('invoice');
    });

    it("AFTER AUTH: balance should be -100 CHF (blocked)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterAuth = defaultCustomer.balance;
      
      balanceAfterAuth.should.equal(-AUTH_AMOUNT);
      console.log(`   ✅ Balance APRÈS auth: ${balanceAfterAuth} CHF (bloqué: ${AUTH_AMOUNT} CHF)`);
    });

    it("Capture 115 CHF (+15% overcapture) DOIT RÉUSSIR", async function() {
      console.log(`\n   ⏳ Tentative de capture: ${CAPTURE_AMOUNT} CHF (+15%)`);
      
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      
      await loadedTx.capture(CAPTURE_AMOUNT);
      
      loadedTx.captured.should.equal(true);
      loadedTx.amount.should.equal(CAPTURE_AMOUNT);
      
      console.log(`   ✅ OVERCAPTURE RÉUSSI: ${loadedTx.amount} CHF capturés`);
    });

    it("AFTER CAPTURE: balance should be -115 CHF (overcapture delta debited)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterCapture = defaultCustomer.balance;
      
      //
      // Le crédit final doit être -CAPTURE_AMOUNT (-115 CHF)
      balanceAfterCapture.should.equal(-CAPTURE_AMOUNT);
      
      //
      // Vérifier le delta d'overcapture
      const actualDelta = Math.abs(balanceAfterCapture) - Math.abs(balanceAfterAuth);
      actualDelta.should.equal(OVERCAPTURE_DELTA);
      
      console.log(`   ✅ Balance APRÈS capture: ${balanceAfterCapture} CHF`);
      console.log(`   ✅ Delta overcapture débité: ${OVERCAPTURE_DELTA} CHF`);
      console.log(`   📊 Résumé: 0 → -${AUTH_AMOUNT} (auth) → -${CAPTURE_AMOUNT} (capture+overcapture)`);
    });
  });

  //
  // Test: Overcapture +20% (limite exacte) - avec vérification complète du balance
  //
  describe("Invoice overcapture +20% (limite exacte)", function() {
    let tx;
    let balanceBeforeAuth;
    let balanceAfterAuth;
    let balanceAfterCapture;
    const AUTH_AMOUNT = 50;
    const CAPTURE_AMOUNT = 60; // +20% (limite exacte)
    const OVERCAPTURE_DELTA = CAPTURE_AMOUNT - AUTH_AMOUNT; // 10 CHF

    before(async function() {
      //
      // Reset customer balance
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      if (defaultCustomer.balance !== 0) {
        await defaultCustomer.updateCredit(-defaultCustomer.balance, 'reset-for-overcapture-20pct');
        defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      }
    });

    it("BEFORE AUTH: balance should be 0", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceBeforeAuth = defaultCustomer.balance;
      
      balanceBeforeAuth.should.equal(0);
      console.log(`   ✅ Balance AVANT auth: ${balanceBeforeAuth} CHF`);
    });

    it("Authorize 50 CHF via invoice", async function() {
      tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'invoice-overcapture-20pct'
      });
      
      tx.authorized.should.equal(true);
      tx.amount.should.equal(AUTH_AMOUNT);
    });

    it("AFTER AUTH: balance should be -50 CHF (blocked)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterAuth = defaultCustomer.balance;
      
      balanceAfterAuth.should.equal(-AUTH_AMOUNT);
      console.log(`   ✅ Balance APRÈS auth: ${balanceAfterAuth} CHF`);
    });

    it("Capture 60 CHF (+20% overcapture limite) DOIT RÉUSSIR", async function() {
      console.log(`\n   ⏳ Tentative de capture: ${CAPTURE_AMOUNT} CHF (+20% limite)`);
      
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      
      await loadedTx.capture(CAPTURE_AMOUNT);
      
      loadedTx.captured.should.equal(true);
      loadedTx.amount.should.equal(CAPTURE_AMOUNT);
    });

    it("AFTER CAPTURE: balance should be -60 CHF (overcapture delta debited)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterCapture = defaultCustomer.balance;
      
      balanceAfterCapture.should.equal(-CAPTURE_AMOUNT);
      
      const actualDelta = Math.abs(balanceAfterCapture) - Math.abs(balanceAfterAuth);
      actualDelta.should.equal(OVERCAPTURE_DELTA);
      
      console.log(`   ✅ Balance APRÈS capture: ${balanceAfterCapture} CHF`);
      console.log(`   ✅ Delta overcapture débité: ${OVERCAPTURE_DELTA} CHF`);
      console.log(`   📊 Résumé: 0 → -${AUTH_AMOUNT} (auth) → -${CAPTURE_AMOUNT} (capture+overcapture limite)`);
    });
  });

  //
  // Test: Overcapture >20% (doit échouer) - avec vérification complète du balance
  //
  describe("Invoice overcapture >20% (doit être REFUSÉ)", function() {
    let tx;
    let balanceBeforeAuth;
    let balanceAfterAuth;
    let balanceAfterFailedCapture;
    let balanceAfterCancel;
    const AUTH_AMOUNT = 100;
    const CAPTURE_AMOUNT = 125; // +25% > limite 20%

    before(async function() {
      //
      // Reset customer balance
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      if (defaultCustomer.balance !== 0) {
        await defaultCustomer.updateCredit(-defaultCustomer.balance, 'reset-for-overcapture-excess');
        defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      }
    });

    it("BEFORE AUTH: balance should be 0", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceBeforeAuth = defaultCustomer.balance;
      
      balanceBeforeAuth.should.equal(0);
      console.log(`   ✅ Balance AVANT auth: ${balanceBeforeAuth} CHF`);
    });

    it("Authorize 100 CHF via invoice", async function() {
      tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'invoice-overcapture-excess'
      });
      
      tx.authorized.should.equal(true);
      tx.amount.should.equal(AUTH_AMOUNT);
    });

    it("AFTER AUTH: balance should be -100 CHF (blocked)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterAuth = defaultCustomer.balance;
      
      balanceAfterAuth.should.equal(-AUTH_AMOUNT);
      console.log(`   ✅ Balance APRÈS auth: ${balanceAfterAuth} CHF`);
    });

    it("Capture 125 CHF (+25%) DOIT ÊTRE REFUSÉ", async function() {
      console.log(`\n   ⏳ Tentative de capture: ${CAPTURE_AMOUNT} CHF (+25% - doit échouer)`);
      
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      
      try {
        await loadedTx.capture(CAPTURE_AMOUNT);
        should.not.exist("dead zone - capture should have thrown");
      } catch(err) {
        console.log(`   ✅ Refus correct: ${err.message}`);
        err.message.should.containEql('greater');
      }
    });

    it("AFTER FAILED CAPTURE: balance should still be -100 CHF (unchanged)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterFailedCapture = defaultCustomer.balance;
      
      //
      // Balance doit être inchangé après échec
      balanceAfterFailedCapture.should.equal(balanceAfterAuth);
      balanceAfterFailedCapture.should.equal(-AUTH_AMOUNT);
      
      console.log(`   ✅ Balance APRÈS échec capture: ${balanceAfterFailedCapture} CHF (inchangé)`);
    });

    it("Cancel transaction for cleanup", async function() {
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      
      if (loadedTx.authorized && !loadedTx.captured) {
        await loadedTx.cancel();
      }
    });

    it("AFTER CANCEL: balance should be 0 (released)", async function() {
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      balanceAfterCancel = defaultCustomer.balance;
      
      balanceAfterCancel.should.equal(0);
      
      console.log(`   ✅ Balance APRÈS annulation: ${balanceAfterCancel} CHF (libéré)`);
      console.log(`   📊 Résumé: 0 → -${AUTH_AMOUNT} (auth) → -${AUTH_AMOUNT} (échec capture) → 0 (annulation)`);
    });
  });

  //
  // Test: Overcapture DÉSACTIVÉ (doit refuser même +1%)
  //
  describe("Invoice overcapture DISABLED (doit tout refuser)", function() {
    let tx;
    const AUTH_AMOUNT = 100;
    const CAPTURE_AMOUNT = 101; // Juste +1%

    before(async function() {
      //
      // Disable overcapture for invoice
      config.option('overcaptureInvoiceEnabled', false);
      
      //
      // Reset customer balance
      defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      if (defaultCustomer.balance !== 0) {
        await defaultCustomer.updateCredit(-defaultCustomer.balance, 'reset-for-disabled-test');
        defaultCustomer = await customer.Customer.get(defaultCustomer.id);
      }
    });

    after(async function() {
      //
      // Re-enable for other tests
      config.option('overcaptureInvoiceEnabled', true);
    });

    it("Authorize 100 CHF via invoice", async function() {
      tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, AUTH_AMOUNT, {
        ...paymentOpts,
        oid: 'invoice-overcapture-disabled'
      });
      
      tx.authorized.should.equal(true);
      console.log(`   ✅ Autorisé: ${AUTH_AMOUNT} CHF (overcapture DISABLED)`);
    });

    it("Capture 101 CHF (+1%) DOIT ÊTRE REFUSÉ (overcapture disabled)", async function() {
      console.log(`\n   ⏳ Tentative de capture: ${CAPTURE_AMOUNT} CHF (+1% - doit échouer car disabled)`);
      
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      
      try {
        await loadedTx.capture(CAPTURE_AMOUNT);
        should.not.exist("dead zone - capture should have thrown");
      } catch(err) {
        console.log(`   ✅ Refus correct (overcapture disabled): ${err.message}`);
        err.message.should.containEql('greater');
      }
    });

    it("Cancel transaction for cleanup", async function() {
      const orderPayment = {
        status: tx.status,
        transaction: tx.id,
        issuer: tx.provider
      };
      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);
      
      if (loadedTx.authorized && !loadedTx.captured) {
        await loadedTx.cancel();
      }
    });
  });

});
