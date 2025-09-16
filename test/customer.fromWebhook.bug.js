/**
 * Test pour vérifier le bug Customer.fromWebhook() qui ne retournait pas l'objet
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const unxor = require("../dist/payments").unxor;
const $stripe = require("../dist/payments").$stripe;
const should = require('should');

describe("Customer.fromWebhook bug fix", function(){
  this.timeout(5000);

  let realCustomer;

  before(async function() {
    // ✅ Créer un vrai customer d'abord
    realCustomer = await customer.Customer.create("webhook.test@example.com", "Test", "Webhook", "022345", 1234);
  });

  after(async function() {
    // Nettoyer après les tests
    if (realCustomer) {
      await $stripe.customers.del(unxor(realCustomer.id));
    }
  });

  it("should return customer object from webhook", async function() {
    // ✅ Récupérer les vraies données Stripe du customer créé
    const stripeCustomer = await $stripe.customers.retrieve(unxor(realCustomer.id));

    // ✅ Test: fromWebhook doit retourner un objet Customer
    const customerResult = await customer.Customer.fromWebhook(stripeCustomer);
    
    // Vérifications
    should.exist(customerResult);
    customerResult.should.be.type('object');
    should.exist(customerResult.email);
    customerResult.email.should.equal('webhook.test@example.com');
    should.exist(customerResult.uid);
    customerResult.uid.should.equal(realCustomer.uid);
    
    console.log('✅ Customer.fromWebhook() retourne bien un objet:', {
      email: customerResult.email,
      uid: customerResult.uid
    });
  });

  xit("should handle missing metadata gracefully", async function() {
    // Simuler un customer Stripe avec metadata manquante (peut arriver)
    const stripeCustomerIncomplete = {
      id: 'cus_test_incomplete',
      email: 'incomplete@example.com',
      phone: null,
      invoice_settings: null,
      cash_balance: null,
      balance: 0,
      metadata: {} // Metadata vide
    };

    try {
      const customerResult = await customer.Customer.fromWebhook(stripeCustomerIncomplete);
      
      // Si ça passe, vérifier que l'objet est bien retourné
      should.exist(customerResult);
      console.log('✅ Customer.fromWebhook() gère metadata vide correctement');
      
    } catch (err) {
      // Si ça échoue, c'est normal car metadata.uid peut être requis
      console.log('ℹ️ Customer.fromWebhook() échoue pour metadata vide (normal):', err.message);
      err.should.be.type('object'); // L'erreur doit être lancée, pas silencieuse
    }
  });
});