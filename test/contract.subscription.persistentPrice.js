/**
 * Karibou payment wrapper
 * Test: Subscription with persistent Price (created in dashboard)
 * 
 * Vérifie que contract.get() charge correctement les subscriptions
 * qui utilisent des Price persistants (price: price_id) au lieu de 
 * price_data inline.
 * 
 * CONTEXTE:
 * - Le code actuel utilise price_data (inline) → Dashboard affiche "Aucun tarif"
 * - Si on crée un Price dans le dashboard, contract.get() doit le charger
 * - Les metadata peuvent être sur le SubscriptionItem OU sur le Price
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);
config.option('debug', false);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const $stripe = require("../dist/payments").$stripe;
const { unxor } = require("../dist/payments");
const should = require('should');

describe("Class subscription.persistentPrice", function() {
  this.timeout(10000);

  let defaultCustomer;
  let methodValid;
  let testProduct;
  let testPricePersistent;
  let testSubscriptionPersistent;
  let testSubscriptionInline;

  before(async function() {
    // 1. Créer customer
    defaultCustomer = await customer.Customer.create(
      "persistent-price-test@email.com",
      "Test",
      "PersistentPrice",
      "022345",
      1234
    );

    // 2. Ajouter méthode de paiement
    methodValid = await $stripe.paymentMethods.create({
      type: 'card',
      card: { number: '4242424242424242', exp_month: 12, exp_year: 2026, cvc: '314' }
    });
    await $stripe.paymentMethods.attach(methodValid.id, { customer: unxor(defaultCustomer.id) });
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });

    // 3. Créer Product (simule ce qu'on ferait dans dashboard)
    testProduct = await $stripe.products.create({
      name: 'test-persistent-sku-9999',
      description: 'Test product with persistent price for unit testing'
    });

    // 4. Créer Price PERSISTANT (simule création dans dashboard)
    testPricePersistent = await $stripe.prices.create({
      unit_amount: 1550,  // 15.50 CHF
      currency: 'chf',
      recurring: { interval: 'week' },
      product: testProduct.id,
      metadata: {
        sku: 'test-persistent-sku-9999',
        type: 'product',
        title: 'Test Persistent Product',
        hub: 'mocha-test'
      }
    });

    console.log('✅ Created Product:', testProduct.id);
    console.log('✅ Created Price:', testPricePersistent.id);
  });

  after(async function() {
    // Cleanup
    try {
      if (testSubscriptionPersistent) {
        await $stripe.subscriptions.cancel(testSubscriptionPersistent.id);
      }
      if (testSubscriptionInline) {
        await $stripe.subscriptions.cancel(testSubscriptionInline.id);
      }
      if (testProduct) {
        await $stripe.products.update(testProduct.id, { active: false });
      }
      if (defaultCustomer) {
        await $stripe.customers.del(unxor(defaultCustomer.id));
      }
    } catch (err) {
      console.log('Cleanup error (ignorable):', err.message);
    }
  });

  // =========================================================================
  // TEST 1: Créer subscription avec Price persistant (comme dashboard)
  // =========================================================================
  it("should create subscription with persistent Price (not price_data)", async function() {
    // Créer Subscription avec price: price_id (PAS price_data)
    testSubscriptionPersistent = await $stripe.subscriptions.create({
      customer: unxor(defaultCustomer.id),
      items: [{
        price: testPricePersistent.id,  // ✅ Price persistant
        quantity: 2,
        metadata: {
          sku: 'test-persistent-sku-9999',
          type: 'product',
          title: 'Test Persistent Product',
          quantity: 2,
          fees: '15.50',
          hub: 'mocha-test',
          part: '1kg'
        }
      }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        uid: '1234',
        fees: '0.06',
        plan: 'customer',
        dayOfWeek: '2',
        address: JSON.stringify({
          streetAdress: 'rue du test 123',
          postalCode: '1200',
          name: 'Test Family',
          hours: 16,
          lat: 46.2,
          lng: 6.1
        })
      }
    });

    should.exist(testSubscriptionPersistent);
    testSubscriptionPersistent.status.should.be.oneOf(['active', 'incomplete']);
    console.log('✅ Created Subscription (persistent):', testSubscriptionPersistent.id);
  });

  // =========================================================================
  // TEST 2: contract.get() doit charger la subscription avec Price persistant
  // =========================================================================
  it("contract.get() should load subscription with persistent Price", async function() {
    // Charger via SubscriptionContract.get()
    const contract = await subscription.SubscriptionContract.get(testSubscriptionPersistent.id);

    should.exist(contract);
    should.exist(contract.content);

    console.log('📋 Contract status:', contract.status);
    console.log('📋 Contract items:', JSON.stringify(contract.content.items, null, 2));

    // ⚠️ POINT DE VÉRIFICATION CRITIQUE
    // Le code actuel filtre par item.metadata.type == 'product'
    // Est-ce que les items sont bien chargés ?
    contract.content.items.length.should.be.above(0, 
      'Items array is empty - parseItem may not handle persistent Price correctly');

    const item = contract.content.items[0];
    
    // Vérifications des données
    item.unit_amount.should.equal(1550, 'unit_amount should be 1550 (15.50 CHF)');
    item.sku.should.equal('test-persistent-sku-9999', 'SKU should match');
    item.quantity.should.equal(2, 'quantity should be 2');
  });

  // =========================================================================
  // TEST 3: Comparer structure raw Stripe pour debug
  // =========================================================================
  it("should inspect raw Stripe item structure with persistent Price", async function() {
    // Recharger directement depuis Stripe pour comparer
    const rawSubscription = await $stripe.subscriptions.retrieve(testSubscriptionPersistent.id);
    const rawItem = rawSubscription.items.data[0];

    console.log('📋 Raw item.id:', rawItem.id);
    console.log('📋 Raw item.metadata:', JSON.stringify(rawItem.metadata, null, 2));
    console.log('📋 Raw item.price.id:', rawItem.price.id);
    console.log('📋 Raw item.price.metadata:', JSON.stringify(rawItem.price.metadata, null, 2));
    console.log('📋 Raw item.price.unit_amount:', rawItem.price.unit_amount);
    console.log('📋 Raw item.price.product:', rawItem.price.product);
    console.log('📋 Raw item.price.product type:', typeof rawItem.price.product);

    // Structure attendue
    should.exist(rawItem.price);
    should.exist(rawItem.price.id);
    rawItem.price.id.should.startWith('price_');  // Price persistant (pas inline)
    rawItem.price.unit_amount.should.equal(1550);
    rawItem.price.product.should.equal(testProduct.id);

    // ⚠️ VÉRIFICATION CRITIQUE: Où sont les metadata ?
    // Avec price_data inline: metadata sur SubscriptionItem
    // Avec Price persistant: metadata peuvent être sur Price OU SubscriptionItem
    console.log('\n⚠️  METADATA LOCATION CHECK:');
    console.log('   item.metadata.type:', rawItem.metadata?.type);
    console.log('   item.price.metadata.type:', rawItem.price.metadata?.type);
  });

  // =========================================================================
  // TEST 4: Créer subscription avec price_data inline pour comparaison
  // =========================================================================
  it("should create subscription with inline price_data (current behavior)", async function() {
    // Créer Subscription avec price_data (comportement actuel)
    testSubscriptionInline = await $stripe.subscriptions.create({
      customer: unxor(defaultCustomer.id),
      items: [{
        price_data: {
          currency: 'chf',
          unit_amount: 1750,  // 17.50 CHF
          product: testProduct.id,
          recurring: { interval: 'week' }
        },
        quantity: 1,
        metadata: {
          sku: 'test-inline-sku-8888',
          type: 'product',
          title: 'Test Inline Product',
          quantity: 1,
          fees: '17.50',
          hub: 'mocha-test',
          part: '500g'
        }
      }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        uid: '1234',
        fees: '0.06',
        plan: 'customer',
        dayOfWeek: '3',
        address: JSON.stringify({
          streetAdress: 'rue du inline 456',
          postalCode: '1201',
          name: 'Inline Test Family',
          hours: 16,
          lat: 46.2,
          lng: 6.1
        })
      }
    });

    should.exist(testSubscriptionInline);
    console.log('✅ Created Subscription (inline):', testSubscriptionInline.id);
  });

  // =========================================================================
  // TEST 5: contract.get() avec price_data inline (doit fonctionner)
  // =========================================================================
  it("contract.get() should load subscription with inline price_data", async function() {
    const contract = await subscription.SubscriptionContract.get(testSubscriptionInline.id);

    should.exist(contract);
    should.exist(contract.content);

    console.log('📋 Inline Contract items:', JSON.stringify(contract.content.items, null, 2));

    contract.content.items.length.should.be.above(0, 
      'Items array is empty - current behavior should work with inline price_data');

    const item = contract.content.items[0];
    item.unit_amount.should.equal(1750, 'unit_amount should be 1750 (17.50 CHF)');
    item.sku.should.equal('test-inline-sku-8888', 'SKU should match');
  });

  // =========================================================================
  // TEST 6: Comparer structure inline vs persistent
  // =========================================================================
  it("should compare inline vs persistent Price structures", async function() {
    const rawInline = await $stripe.subscriptions.retrieve(testSubscriptionInline.id);
    const rawPersistent = await $stripe.subscriptions.retrieve(testSubscriptionPersistent.id);

    const itemInline = rawInline.items.data[0];
    const itemPersistent = rawPersistent.items.data[0];

    console.log('\n📊 COMPARISON: Inline vs Persistent Price');
    console.log('═══════════════════════════════════════════');
    
    console.log('\n🔹 INLINE (price_data):');
    console.log('   price.id:', itemInline.price.id);
    console.log('   item.metadata.sku:', itemInline.metadata?.sku);
    console.log('   item.metadata.type:', itemInline.metadata?.type);
    console.log('   price.metadata.sku:', itemInline.price.metadata?.sku);

    console.log('\n🔹 PERSISTENT (price: price_id):');
    console.log('   price.id:', itemPersistent.price.id);
    console.log('   item.metadata.sku:', itemPersistent.metadata?.sku);
    console.log('   item.metadata.type:', itemPersistent.metadata?.type);
    console.log('   price.metadata.sku:', itemPersistent.price.metadata?.sku);

    console.log('\n═══════════════════════════════════════════');

    // Les deux doivent avoir des metadata accessibles
    // Inline: sur item.metadata
    // Persistent: peut être sur item.metadata OU price.metadata
    
    // Vérifier que le code actuel supporte les deux
    const hasInlineMetadata = itemInline.metadata?.type === 'product';
    const hasPersistentItemMetadata = itemPersistent.metadata?.type === 'product';
    const hasPersistentPriceMetadata = itemPersistent.price.metadata?.type === 'product';

    console.log('\n✓ Inline has item.metadata.type:', hasInlineMetadata);
    console.log('✓ Persistent has item.metadata.type:', hasPersistentItemMetadata);
    console.log('✓ Persistent has price.metadata.type:', hasPersistentPriceMetadata);

    // Au moins une source de metadata doit exister pour chaque type
    hasInlineMetadata.should.be.true('Inline should have item.metadata');
    (hasPersistentItemMetadata || hasPersistentPriceMetadata).should.be.true(
      'Persistent should have metadata on item OR price'
    );
  });

  // =========================================================================
  // TEST 7: CASE CRITIQUE - Price avec metadata mais Item SANS metadata
  // Simule une subscription créée/modifiée dans le Dashboard Stripe
  // =========================================================================
  it("should handle subscription where metadata is ONLY on Price (dashboard scenario)", async function() {
    // Créer une subscription où les metadata sont sur le Price mais PAS sur l'item
    // C'est ce qui arrive si quelqu'un modifie depuis le Dashboard
    const testSubscriptionDashboard = await $stripe.subscriptions.create({
      customer: unxor(defaultCustomer.id),
      items: [{
        price: testPricePersistent.id,  // Price a des metadata
        quantity: 1
        // ⚠️ PAS DE metadata ici !
      }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        uid: '1234',
        fees: '0.06',
        plan: 'customer',
        dayOfWeek: '4',
        address: JSON.stringify({
          streetAdress: 'rue dashboard 789',
          postalCode: '1202',
          name: 'Dashboard Family',
          hours: 16,
          lat: 46.2,
          lng: 6.1
        })
      }
    });

    console.log('\n📋 Dashboard scenario - Subscription created:', testSubscriptionDashboard.id);

    // Inspecter la structure raw
    const raw = await $stripe.subscriptions.retrieve(testSubscriptionDashboard.id);
    const rawItem = raw.items.data[0];
    
    console.log('📋 Dashboard item.metadata:', JSON.stringify(rawItem.metadata, null, 2));
    console.log('📋 Dashboard item.price.metadata:', JSON.stringify(rawItem.price.metadata, null, 2));

    // Charger via contract.get()
    const contract = await subscription.SubscriptionContract.get(testSubscriptionDashboard.id);
    
    console.log('📋 Dashboard Contract items:', JSON.stringify(contract.content.items, null, 2));

    // ⚠️ POINT CRITIQUE: Est-ce que les items sont chargés ?
    // Si item.metadata est vide, le filtre item.metadata.type == 'product' échoue !
    const hasItemMetadata = Object.keys(rawItem.metadata || {}).length > 0;
    const hasPriceMetadata = Object.keys(rawItem.price.metadata || {}).length > 0;
    
    console.log('\n⚠️  DASHBOARD SCENARIO:');
    console.log('   item.metadata empty?:', !hasItemMetadata);
    console.log('   price.metadata exists?:', hasPriceMetadata);
    console.log('   contract.items.length:', contract.content.items.length);

    // Cleanup
    await $stripe.subscriptions.cancel(testSubscriptionDashboard.id);

    // ASSERTION: Le code actuel devrait supporter les deux sources de metadata
    // Ce test expose le comportement actuel
    if (!hasItemMetadata && hasPriceMetadata) {
      console.log('\n🚨 SCENARIO: metadata sur Price UNIQUEMENT (pas sur Item)');
      
      if (contract.content.items.length === 0) {
        console.log('   → BUG: contract.content.items est VIDE');
        console.log('   → CORRECTION NÉCESSAIRE: utiliser price.metadata comme fallback');
        // Ce test DOIT échouer pour révéler le bug
        contract.content.items.length.should.be.above(0, 
          'Items should be loaded even when metadata is only on Price');
      } else {
        console.log('   → OK: items chargés malgré metadata seulement sur Price');
      }
    }
  });

  // =========================================================================
  // TEST 8: MINIMAL Dashboard - Seulement type sur Price, SKU/title du Product
  // Convention: product.name=SKU, product.description=title
  // =========================================================================
  it("should load subscription with MINIMAL metadata (only type, SKU from product.name)", async function() {
    // Créer un Product avec name=SKU et description=title (convention Karibou)
    const minimalProduct = await $stripe.products.create({
      name: 'minimal-sku-7777',  // ← SKU
      description: 'Minimal Product Title (500g)'  // ← title(part)
    });

    // Créer un Price avec SEULEMENT type dans metadata
    const minimalPrice = await $stripe.prices.create({
      unit_amount: 2500,  // 25.00 CHF
      currency: 'chf',
      recurring: { interval: 'week' },
      product: minimalProduct.id,
      metadata: {
        type: 'product'  // ← SEULEMENT type !
        // PAS de sku, title, hub, fees, part
      }
    });

    console.log('\n📋 Minimal scenario - Product.name:', minimalProduct.name);
    console.log('📋 Minimal scenario - Product.description:', minimalProduct.description);
    console.log('📋 Minimal scenario - Price.metadata:', minimalPrice.metadata);

    // Créer subscription avec ce Price minimal
    const minimalSubscription = await $stripe.subscriptions.create({
      customer: unxor(defaultCustomer.id),
      items: [{
        price: minimalPrice.id,
        quantity: 1
        // PAS de metadata sur l'item !
      }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        uid: '1234',
        fees: '0.06',
        plan: 'customer',
        dayOfWeek: '5',
        address: JSON.stringify({
          streetAdress: 'rue minimal 999',
          postalCode: '1203',
          name: 'Minimal Family',
          hours: 16,
          lat: 46.2,
          lng: 6.1
        })
      }
    });

    // Charger via contract.get()
    const contract = await subscription.SubscriptionContract.get(minimalSubscription.id);
    
    console.log('📋 Minimal Contract items:', JSON.stringify(contract.content.items, null, 2));

    // Vérifications
    contract.content.items.length.should.be.above(0, 'Items should be loaded');
    
    const item = contract.content.items[0];
    
    // SKU déduit de product.name
    item.sku.should.equal('minimal-sku-7777', 'SKU should come from product.name');
    
    // Title déduit de product.description
    item.title.should.equal('Minimal Product Title (500g)', 'Title should come from product.description');
    
    // Fees déduit de price.unit_amount
    item.fees.should.equal(25, 'Fees should be deduced from unit_amount (2500/100)');

    console.log('\n✅ MINIMAL DASHBOARD SCENARIO: SUCCESS');
    console.log('   SKU from product.name:', item.sku);
    console.log('   Title from product.description:', item.title);
    console.log('   Fees from unit_amount:', item.fees);

    // Cleanup
    await $stripe.subscriptions.cancel(minimalSubscription.id);
    await $stripe.products.update(minimalProduct.id, { active: false });
  });

});

