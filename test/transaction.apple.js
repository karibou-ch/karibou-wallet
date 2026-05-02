/**
 * Karibou payment wrapper
 * Test Apple Pay / Google Pay - Wallet Payment
 * 
 * Ce test simule le flux Apple Pay / Google Pay avec checkMethods:
 * 1. checkMethods() crée un walletIntent (PaymentIntent)
 * 2. Frontend confirme avec confirmCardPayment(client_secret, {payment_method})
 * 3. Frontend passe payment_intent en clair à authorize()
 * 4. authorize() récupère la transaction existante
 * 5. capture() fonctionne normalement
 * 
 * Usage:
 *   NODE_ENV=test npx mocha test/transaction.apple.js --exit
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const xor = require("../dist/payments").xor;
const KngPayment = require("../dist/payments").KngPayment;
const card_mastercard_prepaid = require("../dist/payments").card_mastercard_prepaid;

const transaction = require("../dist/transaction");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');


describe("Class transaction.apple (Apple Pay / Google Pay)", function(){
  this.timeout(15000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let testPaymentMethodId;

  const paymentOpts = {
    oid: 'wallet-test',
    txgroup: 'WALLET',
    email: 'test-wallet@karibou.ch',
    shipping: {
      streetAdress: 'rue du rhone 69',
      postalCode: '1208',
      name: 'foo bar family'
    }
  };

  before(async function(){
    config.option('debug', false);
    
    // Créer customer de test
    defaultCustomer = await customer.Customer.create("test-wallet@email.com", "Foo", "Bar", "022345", 1234);
    
    // Ajouter une carte de test (pour simuler le payment_method du wallet)
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;
    testPaymentMethodId = unxor(card.id);
  });

  after(async function () {
    if (defaultCustomer) {
      await $stripe.customers.del(unxor(defaultCustomer.id));
    }
  });

  describe("checkMethods avec walletIntent", function() {
    it("checkMethods retourne walletIntent quand amount est fourni", async function() {
      const result = await defaultCustomer.checkMethods(false, 50);
      
      result.should.have.property('walletIntent');
      result.walletIntent.should.have.property('id');
      result.walletIntent.should.have.property('client_secret');
      result.walletIntent.id.should.startWith('pi_');
      
      console.log(`   ✅ walletIntent créé: ${result.walletIntent.id}`);
      console.log(`   ✅ client_secret: ${result.walletIntent.client_secret.substring(0, 30)}...`);
      
      // Cleanup
      await $stripe.paymentIntents.cancel(result.walletIntent.id);
    });

    it("checkMethods sans amount ne crée pas walletIntent", async function() {
      const result = await defaultCustomer.checkMethods(false);
      
      result.should.have.property('walletIntent');
      result.walletIntent.should.equal(false);
      
      console.log(`   ✅ Pas de walletIntent sans amount`);
    });
  });

  describe("Apple Pay Flow via createWalletIntent", function() {
    let walletIntent;
    let tx;

    it("1. createWalletIntent crée un PaymentIntent", async function() {
      // Simule ce que fait checkMethods
      walletIntent = await defaultCustomer.createWalletIntent(50);

      walletIntent.should.have.property('client_secret');
      walletIntent.should.have.property('id');
      walletIntent.id.should.startWith('pi_');
      walletIntent.status.should.equal('requires_payment_method');
      
      console.log(`   ✅ PaymentIntent créé: ${walletIntent.id}`);
    });

    it("2. Frontend confirme avec Apple Pay (simulé)", async function() {
      // Simule stripe.confirmCardPayment(client_secret, {payment_method})
      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      walletIntent.status.should.equal('requires_capture');
      console.log(`   ✅ PaymentIntent confirmé: status=${walletIntent.status}`);
    });

    it("3. authorize() avec payment_intent EN CLAIR (pas de xor)", async function() {
      // Le frontend passe l'ID en clair (pi_xxx) - pas de xor nécessaire
      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: walletIntent.id  // ✅ ID en clair, pas xor
      };

      tx = await transaction.Transaction.authorize(
        defaultCustomer, 
        appleCard, 
        50, 
        { ...paymentOpts, oid: 'apple-pay-test-' + Date.now() }
      );

      tx.should.exist;
      tx.authorized.should.equal(true);
      tx.status.should.equal('authorized');
      tx.amount.should.equal(50);
      
      console.log(`   ✅ Transaction récupérée: ${tx.id}`);
      console.log(`   ✅ Status: ${tx.status}, Amount: ${tx.amount} CHF`);
    });

    it("4. capture() fonctionne normalement", async function() {
      await tx.capture(45);  // Capture 45 CHF sur 50 autorisés

      tx.captured.should.equal(true);
      tx.amount.should.equal(45);
      
      console.log(`   ✅ Capture réussie: ${tx.amount} CHF`);
    });

    it("5. refund() fonctionne normalement", async function() {
      await tx.refund();

      tx.refunded.should.equal(45);
      
      console.log(`   ✅ Refund réussi: ${tx.refunded} CHF`);
    });
  });

  describe("Google Pay Flow via createWalletIntent", function() {
    let walletIntent;
    let tx;

    it("1. Créer et confirmer via createWalletIntent", async function() {
      // Création via customer
      walletIntent = await defaultCustomer.createWalletIntent(30);

      // Confirmation (simule Google Pay)
      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      walletIntent.status.should.equal('requires_capture');
      console.log(`   ✅ Google Pay PaymentIntent confirmé`);
    });

    it("2. authorize() avec Google Pay (ID en clair)", async function() {
      const googleCard = {
        type: KngPayment.google,
        issuer: 'google',
        alias: 'google',
        payment_intent: walletIntent.id  // ✅ ID en clair
      };

      tx = await transaction.Transaction.authorize(
        defaultCustomer, 
        googleCard, 
        30, 
        { ...paymentOpts, oid: 'google-pay-test-' + Date.now() }
      );

      tx.authorized.should.equal(true);
      tx.amount.should.equal(30);
      
      console.log(`   ✅ Google Pay transaction: ${tx.amount} CHF`);
    });

    it("3. capture() complet", async function() {
      await tx.capture(30);
      tx.captured.should.equal(true);
      
      // Cleanup
      await tx.refund();
      console.log(`   ✅ Google Pay capture + refund OK`);
    });
  });

  describe("Quote-backed wallet invariants", function() {
    it("automatic capture quote becomes prepaid only after Stripe succeeds", async function() {
      let walletIntent = await defaultCustomer.createWalletIntent({
        amount: 10,
        currency: 'chf',
        capture_method: 'automatic',
        quoteKey: 'quote-automatic-test'
      });

      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      walletIntent.status.should.equal('succeeded');

      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: walletIntent.id
      };

      const tx = await transaction.Transaction.authorize(
        defaultCustomer,
        appleCard,
        10,
        { ...paymentOpts, oid: 'apple-pay-prepaid-' + Date.now() }
      );

      tx.status.should.equal('prepaid');
      tx._payment.capture_method.should.equal('automatic');
      tx._payment.metadata.exended_status.should.equal('prepaid');

      await tx.refund();
    });

    it("rejects wallet intent when amount does not match checkout quote", async function() {
      let walletIntent = await defaultCustomer.createWalletIntent({
        amount: 12,
        currency: 'chf',
        capture_method: 'manual',
        quoteKey: 'quote-amount-mismatch-test'
      });

      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: walletIntent.id
      };

      try {
        await transaction.Transaction.authorize(
          defaultCustomer,
          appleCard,
          11,
          { ...paymentOpts, oid: 'apple-pay-mismatch-' + Date.now() }
        );
        should.fail('Expected amount mismatch to reject');
      } catch(err) {
        err.message.should.containEql('amount');
      }

      const canceledIntent = await $stripe.paymentIntents.retrieve(walletIntent.id);
      canceledIntent.status.should.equal('canceled');
    });

    it("applies coupon after quote-backed wallet intent was authorized net of coupon", async function() {
      const coupon = await $stripe.coupons.create({
        amount_off: 1000,
        currency:'CHF'
      });

      let walletIntent = await defaultCustomer.createWalletIntent({
        amount: 2,
        currency: 'chf',
        capture_method: 'manual',
        quoteKey: 'quote-coupon-net-test'
      });

      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: walletIntent.id
      };

      const tx = await transaction.Transaction.authorize(
        defaultCustomer,
        appleCard,
        2,
        {
          ...paymentOpts,
          oid: 'apple-pay-coupon-net-' + Date.now(),
          coupon: coupon.id
        }
      );

      tx.amount.should.equal(2);
      tx.creditNote.should.equal(10);
      tx._payment.metadata.coupon.should.equal(coupon.id);
      tx._payment.metadata.coupon_amount.should.equal('1000');

      await tx.cancel();
    });

    it("cancels wallet intent when coupon was already consumed", async function() {
      const coupon = await $stripe.coupons.create({
        amount_off: 500,
        currency:'CHF'
      });

      await defaultCustomer.applyCoupon(coupon.id, 20);

      let walletIntent = await defaultCustomer.createWalletIntent({
        amount: 15,
        currency: 'chf',
        capture_method: 'manual',
        quoteKey: 'quote-coupon-consumed-test'
      });

      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: walletIntent.id
      };

      try {
        await transaction.Transaction.authorize(
          defaultCustomer,
          appleCard,
          15,
          {
            ...paymentOpts,
            oid: 'apple-pay-coupon-consumed-' + Date.now(),
            coupon: coupon.id
          }
        );
        should.fail('Expected consumed coupon to reject');
      } catch(err) {
        err.message.should.containEql('No such coupon');
      }

      const canceledIntent = await $stripe.paymentIntents.retrieve(walletIntent.id);
      canceledIntent.status.should.equal('canceled');
    });
  });

  describe("Compatibilité legacy (ID xor)", function() {
    let walletIntent;

    it("authorize() accepte aussi les IDs xor (rétrocompatibilité)", async function() {
      // Création et confirmation
      walletIntent = await defaultCustomer.createWalletIntent(25);
      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      // Utiliser xor pour la rétrocompatibilité
      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: xor(walletIntent.id)  // Legacy: xor
      };

      const tx = await transaction.Transaction.authorize(
        defaultCustomer, 
        appleCard, 
        25, 
        { ...paymentOpts, oid: 'apple-legacy-' + Date.now() }
      );

      tx.authorized.should.equal(true);
      tx.amount.should.equal(25);
      
      // Cleanup
      await tx.capture(25);
      await tx.refund();
      
      console.log(`   ✅ ID xor fonctionne aussi (legacy)`);
    });
  });

  describe("Transaction.fromOrder avec Apple Pay / Google Pay", function() {
    let walletIntent;
    let tx;

    it("1. Créer une transaction Apple Pay pour fromOrder", async function() {
      // Création et confirmation
      walletIntent = await defaultCustomer.createWalletIntent(35);
      walletIntent = await $stripe.paymentIntents.confirm(walletIntent.id, {
        payment_method: testPaymentMethodId
      });

      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: walletIntent.id
      };

      tx = await transaction.Transaction.authorize(
        defaultCustomer, 
        appleCard, 
        35, 
        { ...paymentOpts, oid: 'apple-fromorder-' + Date.now() }
      );

      tx.authorized.should.equal(true);
      console.log(`   ✅ Transaction Apple Pay créée: ${tx.id}`);
    });

    it("2. fromOrder() charge correctement une transaction Apple Pay", async function() {
      // Simuler le payment object d'une commande avec issuer='apple'
      // Note: order.payment.transaction stocke l'ID xor-é (tx.id)
      const orderPayment = {
        issuer: 'apple',
        transaction: tx.id  // ID xor-é tel que stocké dans la DB
      };

      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);

      loadedTx.should.exist;
      loadedTx.id.should.equal(tx.id);
      loadedTx.authorized.should.equal(true);
      loadedTx.amount.should.equal(35);
      
      console.log(`   ✅ fromOrder() charge Apple Pay: ${loadedTx.id}`);
    });

    it("3. fromOrder() charge correctement une transaction Google Pay", async function() {
      // Créer une transaction Google Pay
      const googleIntent = await defaultCustomer.createWalletIntent(40);
      const confirmedIntent = await $stripe.paymentIntents.confirm(googleIntent.id, {
        payment_method: testPaymentMethodId
      });

      const googleCard = {
        type: KngPayment.google,
        issuer: 'google',
        alias: 'google',
        payment_intent: confirmedIntent.id
      };

      const googleTx = await transaction.Transaction.authorize(
        defaultCustomer, 
        googleCard, 
        40, 
        { ...paymentOpts, oid: 'google-fromorder-' + Date.now() }
      );

      // Simuler le payment object d'une commande avec issuer='google'
      // Note: order.payment.transaction stocke l'ID xor-é (googleTx.id)
      const orderPayment = {
        issuer: 'google',
        transaction: googleTx.id  // ID xor-é tel que stocké dans la DB
      };

      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);

      loadedTx.should.exist;
      loadedTx.id.should.equal(googleTx.id);
      loadedTx.authorized.should.equal(true);
      loadedTx.amount.should.equal(40);
      
      console.log(`   ✅ fromOrder() charge Google Pay: ${loadedTx.id}`);

      // Cleanup
      await googleTx.capture(40);
      await googleTx.refund();
    });

    it("4. capture() via fromOrder fonctionne", async function() {
      // Recharger la transaction via fromOrder
      // Note: order.payment.transaction stocke l'ID xor-é (tx.id)
      const orderPayment = {
        issuer: 'apple',
        transaction: tx.id  // ID xor-é tel que stocké dans la DB
      };

      const loadedTx = await transaction.Transaction.fromOrder(orderPayment);

      // Capturer via la transaction rechargée
      await loadedTx.capture(35);
      
      loadedTx.captured.should.equal(true);
      loadedTx.amount.should.equal(35);
      
      console.log(`   ✅ capture() via fromOrder: ${loadedTx.amount} CHF`);

      // Cleanup
      await loadedTx.refund();
    });
  });

  describe("Erreurs et edge cases", function() {
    
    it("Rejette PaymentIntent avec mauvais status", async function() {
      // Créer un PaymentIntent non confirmé
      const badIntent = await defaultCustomer.createWalletIntent(10);

      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple',
        payment_intent: badIntent.id  // Non confirmé!
      };

      let errorThrown = false;
      try {
        await transaction.Transaction.authorize(
          defaultCustomer, 
          appleCard, 
          10, 
          paymentOpts
        );
      } catch(err) {
        errorThrown = true;
        err.message.should.containEql('PaymentIntent invalide');
        console.log(`   ✅ Erreur correcte: ${err.message}`);
      }

      errorThrown.should.equal(true);

      // Cleanup
      await $stripe.paymentIntents.cancel(badIntent.id);
    });

    it("Apple Pay sans payment_intent rejette avec erreur", async function() {
      // Apple Pay / Google Pay DOIVENT fournir un payment_intent créé via createWalletIntent
      const appleCard = {
        type: KngPayment.apple,
        issuer: 'apple',
        alias: 'apple'
        // Pas de payment_intent - doit échouer
      };

      let errorThrown = false;
      try {
        await transaction.Transaction.authorize(
          defaultCustomer, 
          appleCard, 
          15, 
          { ...paymentOpts, oid: 'apple-no-intent-' + Date.now() }
        );
      } catch(err) {
        errorThrown = true;
        err.message.should.containEql('payment_intent');
        console.log(`   ✅ Erreur correcte: ${err.message}`);
      }

      errorThrown.should.equal(true);
    });
  });

});
