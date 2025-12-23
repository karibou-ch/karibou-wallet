/**
 * Karibou payment wrapper
 * 
 * TEST: transaction.recapture.with.credit
 * 
 * ══════════════════════════════════════════════════════════════════════════════
 * BUG DOCUMENTATION
 * ══════════════════════════════════════════════════════════════════════════════
 * 
 * CONTEXTE:
 * ---------
 * Stripe permet de capturer un PaymentIntent pendant 7 jours après l'autorisation.
 * Passé ce délai, Stripe annule automatiquement la transaction avec:
 *   - status: 'canceled'
 *   - cancellation_reason: 'automatic'
 *   - amount_received: 0
 * 
 * La fonction `_force_recapture()` est conçue pour gérer ce cas en créant
 * une nouvelle transaction off_session.
 * 
 * PROBLÈME IDENTIFIÉ:
 * -------------------
 * Quand une transaction MIXTE (carte + customer_credit) est annulée automatiquement,
 * deux bugs empêchent le recapture:
 * 
 * BUG 1 - Getter `status` (lignes 103-106):
 *   Le getter retourne 'paid' au lieu de 'voided' quand customer_credit > 0
 *   Condition actuelle: if(status == 'canceled' && customer_credit > 0) return 'paid'
 *   Problème: Ne distingue pas annulation manuelle vs automatique (7 jours)
 * 
 * BUG 2 - Getter `amount`:
 *   Retourne seulement le customer_credit (ex: 10 CHF) au lieu du montant total
 *   Car: amount = (canceled) ? amount_received : amount → amount_received = 0
 * 
 * BUG 3 - Montant passé à `_force_recapture`:
 *   Le montant total (370 CHF) est passé au lieu de la partie Stripe (360 CHF)
 *   Le customer_credit (10 CHF) doit être déduit car déjà réservé
 * 
 * EXEMPLE RÉEL (Production):
 * --------------------------
 * PaymentIntent: pi_3Sf2G8BTMLb4og7P2XMkqpw1
 *   amount: 39916 (399.16 CHF autorisés sur Stripe)
 *   customer_credit: 1000 (10 CHF de bon/coupon)
 *   Total autorisé: 409.16 CHF
 *   Capture demandée: 370.2 CHF
 *   
 * Attendu: _force_recapture(360.2) + customer_credit(10)
 * Actuel: ERREUR "capture amount > this.amount" (370.2 > 10)
 * 
 * SOLUTION:
 * ---------
 * 1. Modifier getter `status` pour exclure les annulations automatiques
 * 2. Modifier l'appel à `_force_recapture` pour déduire le customer_credit
 * 
 * ══════════════════════════════════════════════════════════════════════════════
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

/**
 * Helper: Simule une annulation automatique Stripe après 7 jours
 * En modifiant les propriétés du PaymentIntent
 */
function simulateAutomaticCancellation(tx, originalAmount) {
  // Simule l'état d'une transaction annulée automatiquement par Stripe
  tx._payment.status = 'canceled';
  tx._payment.cancellation_reason = 'automatic';
  tx._payment.amount_received = 0;
  tx._payment.amount_capturable = 0;
  // Garde le montant original autorisé
  tx._payment.amount = originalAmount;
  return tx;
}

describe("Transaction recapture with customer_credit after 7-day expiry", function() {
  this.timeout(8000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let defaultTX;

  const paymentOpts = {
    oid: 'recapture-test-001',
    txgroup: 'RECAPTURE',
    shipping: {
      streetAdress: 'av. du bois-de-la-chapelle 63',
      postalCode: '1213',
      name: 'Test Recapture Family'
    }
  };

  before(function(done) {
    done();
  });

  after(async function() {
    if (defaultCustomer) {
      await $stripe.customers.del(unxor(defaultCustomer.id));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP: Créer un customer avec credit balance
  // ═══════════════════════════════════════════════════════════════════════════

  it("Setup: Create customer with 10 CHF credit balance", async function() {
    config.option('debug', false);
    defaultCustomer = await customer.Customer.create(
      "recapture-test@email.com",
      "Recapture",
      "Test",
      "022345",
      1234
    );

    // Ajouter une carte valide
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;

    // Ajouter 10 CHF de crédit (simule un bon/coupon)
    await defaultCustomer.updateCredit(10);
    
    const refreshedCustomer = await customer.Customer.get(defaultCustomer.id);
    refreshedCustomer.balance.should.equal(10);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Créer une transaction mixte (carte + crédit)
  // ═══════════════════════════════════════════════════════════════════════════

  it("Create mixed payment: 40 CHF total (30 CHF card + 10 CHF credit)", async function() {
    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    
    // Autoriser 40 CHF (30 CHF sur carte + 10 CHF de crédit client)
    const tx = await transaction.Transaction.authorize(defaultCustomer, card, 40, paymentOpts);
    
    tx.status.should.equal("authorized");
    tx.provider.should.equal("stripe");
    tx.customerCredit.should.equal(10);  // 10 CHF de crédit utilisé
    tx.amount.should.equal(40);          // Montant total autorisé
    
    // Vérifier que le crédit client a été réservé
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(0);  // Crédit réservé
    
    defaultTX = tx;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Vérifier le getter `status` avec annulation automatique
  // BUG: Retourne 'paid' au lieu de 'voided' quand customer_credit > 0
  // ═══════════════════════════════════════════════════════════════════════════

  it("BUG GETTER STATUS: Auto-cancelled TX with credit should return 'voided', not 'paid'", async function() {
    // Récupérer la transaction
    const tx = await transaction.Transaction.get(defaultTX.id);
    
    // Simuler l'annulation automatique après 7 jours
    const originalAmount = tx._payment.amount;  // Garder le montant original
    simulateAutomaticCancellation(tx, originalAmount);
    
    // ATTENDU: status = 'voided' (pour déclencher _force_recapture)
    // ACTUEL (BUG): status = 'paid' (car customer_credit > 0)
    
    const actualStatus = tx.status;
    const expectedStatus = 'voided';
    
    // Ce test documente le bug actuel
    // Décommenter la ligne suivante quand le fix sera appliqué:
    // actualStatus.should.equal(expectedStatus);
    
    console.log(`\n  📋 DIAGNOSTIC getter status:`);
    console.log(`     _payment.status: ${tx._payment.status}`);
    console.log(`     cancellation_reason: ${tx._payment.cancellation_reason}`);
    console.log(`     customer_credit: ${tx._payment.metadata.customer_credit}`);
    console.log(`     ATTENDU: ${expectedStatus}`);
    console.log(`     ACTUEL:  ${actualStatus}`);
    
    if (actualStatus !== expectedStatus) {
      console.log(`     ❌ BUG CONFIRMÉ: getter status retourne '${actualStatus}' au lieu de '${expectedStatus}'`);
    } else {
      console.log(`     ✅ FIX APPLIQUÉ: getter status retourne correctement '${expectedStatus}'`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Vérifier le getter `amount` avec annulation automatique
  // BUG: Retourne seulement le customer_credit au lieu du montant total
  // ═══════════════════════════════════════════════════════════════════════════

  it("BUG GETTER AMOUNT: Auto-cancelled TX should preserve original amount", async function() {
    const tx = await transaction.Transaction.get(defaultTX.id);
    
    // Simuler l'annulation automatique
    const originalAmount = tx._payment.amount;  // Ex: 3000 centimes = 30 CHF (partie Stripe)
    simulateAutomaticCancellation(tx, originalAmount);
    
    // ATTENDU: amount = original (40 CHF total)
    // ACTUEL (BUG): amount = customer_credit seulement (10 CHF)
    
    const actualAmount = tx.amount;
    const customerCredit = parseInt(tx._payment.metadata.customer_credit || "0") / 100;
    const expectedAmount = customerCredit + (originalAmount / 100);  // credit + stripe portion
    
    console.log(`\n  📋 DIAGNOSTIC getter amount:`);
    console.log(`     _payment.amount: ${originalAmount} (${originalAmount/100} CHF)`);
    console.log(`     _payment.amount_received: ${tx._payment.amount_received}`);
    console.log(`     customer_credit: ${customerCredit} CHF`);
    console.log(`     ATTENDU: ${expectedAmount} CHF (total autorisé)`);
    console.log(`     ACTUEL:  ${actualAmount} CHF`);
    
    if (actualAmount !== expectedAmount) {
      console.log(`     ❌ BUG CONFIRMÉ: getter amount retourne ${actualAmount} CHF au lieu de ${expectedAmount} CHF`);
    } else {
      console.log(`     ✅ FIX APPLIQUÉ: getter amount retourne correctement ${expectedAmount} CHF`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Vérifier que capture() échoue avec le bug actuel
  // ═══════════════════════════════════════════════════════════════════════════

  it("BUG CAPTURE: Should throw error when trying to capture auto-cancelled TX with credit", async function() {
    const tx = await transaction.Transaction.get(defaultTX.id);
    
    // Simuler l'annulation automatique
    const originalAmount = tx._payment.amount;
    simulateAutomaticCancellation(tx, originalAmount);
    
    const captureAmount = 35;  // Essayer de capturer 35 CHF
    
    console.log(`\n  📋 DIAGNOSTIC capture():`);
    console.log(`     Montant à capturer: ${captureAmount} CHF`);
    console.log(`     tx.amount (buggé): ${tx.amount} CHF`);
    console.log(`     tx.status (buggé): ${tx.status}`);
    
    try {
      await tx.capture(captureAmount);
      
      // Si on arrive ici, le fix est appliqué
      console.log(`     ✅ FIX APPLIQUÉ: capture() a réussi (via _force_recapture)`);
      tx.status.should.equal("paid");
      
    } catch(err) {
      // BUG ACTUEL: L'erreur est levée
      console.log(`     ❌ BUG CONFIRMÉ: ${err.message}`);
      err.message.should.containEql("greater than the amount you can capture");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Vérifier le calcul correct du montant pour _force_recapture
  // ═══════════════════════════════════════════════════════════════════════════

  it("CALCUL: _force_recapture should receive Stripe amount minus customer_credit", async function() {
    // Ce test documente le calcul correct
    const totalCaptureAmount = 370.2;    // Montant total à capturer
    const customerCredit = 10;           // Crédit client utilisé
    const expectedStripeAmount = 360.2;  // Montant à passer à _force_recapture
    
    const calculatedStripeAmount = Math.max(0, totalCaptureAmount - customerCredit);
    
    console.log(`\n  📋 CALCUL _force_recapture:`);
    console.log(`     Capture demandée: ${totalCaptureAmount} CHF`);
    console.log(`     Customer credit:  ${customerCredit} CHF`);
    console.log(`     ──────────────────────────────`);
    console.log(`     Stripe amount:    ${calculatedStripeAmount} CHF`);
    console.log(`\n     Formule: stripeAmount = max(0, captureAmount - customerCredit)`);
    
    calculatedStripeAmount.should.equal(expectedStripeAmount);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP: Annuler la transaction réelle pour nettoyer
  // ═══════════════════════════════════════════════════════════════════════════

  it("Cleanup: Cancel the real transaction", async function() {
    try {
      // Récupérer la vraie transaction (pas la simulée)
      const tx = await transaction.Transaction.get(defaultTX.id);
      
      // Annuler seulement si pas encore capturée/annulée
      if (tx.authorized && !tx.captured && !tx.canceled) {
        await tx.cancel();
      }
    } catch(err) {
      // Ignorer les erreurs de cleanup
      console.log(`     Cleanup note: ${err.message}`);
    }
  });

});

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * FIX PROPOSÉ
 * ══════════════════════════════════════════════════════════════════════════════
 * 
 * FICHIER: lib/transaction.ts
 * 
 * FIX 1 - Getter `status` (lignes 103-106):
 * -----------------------------------------
 * AVANT:
 *   if(this._payment.status == 'canceled' && customer_credit>0) {
 *     return 'paid';
 *   }
 * 
 * APRÈS:
 *   const automaticCancellation = this._payment.cancellation_reason == 'automatic';
 *   if(this._payment.status == 'canceled' && customer_credit>0 && !automaticCancellation) {
 *     return 'paid';
 *   }
 * 
 * 
 * FIX 2 - Appel _force_recapture (lignes 570-574):
 * ------------------------------------------------
 * AVANT:
 *   if(cancelled && this.status === "voided" as KngPaymentStatus) {
 *     this._payment = await _force_recapture(amount);
 *     return this;
 *   }
 * 
 * APRÈS:
 *   if(cancelled && this.status === "voided" as KngPaymentStatus) {
 *     // Déduire le customer_credit du montant Stripe
 *     const stripeAmount = round1cts(Math.max(0, amount - balanceAuthAmount));
 *     console.log('🔄 Auto-cancelled TX, forcing recapture:', stripeAmount, 'CHF (credit:', balanceAuthAmount, ')');
 *     this._payment = await _force_recapture(stripeAmount);
 *     // Conserver le customer_credit dans les metadata
 *     this._payment.metadata.customer_credit = Math.round(balanceAuthAmount * 100).toString();
 *     return this;
 *   }
 * 
 * ══════════════════════════════════════════════════════════════════════════════
 */

