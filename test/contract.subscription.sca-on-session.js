/**
 * Wallet SCA — workflow Stripe (docs/billing/subscriptions/overview):
 * create/update prépare latest_invoice.payment_intent + client_secret, sans confirm Node.
 * Front: confirmCardPayment(client_secret). 3220 → requires_action + modal 3DS.
 * Mocha: 3220 s'arrête à requires_confirmation|requires_action (pas de Stripe.js).
 * paymentIntents.confirm(secret) n'est qu'un stand-in 4242 (carte non enrôlée 3DS).
 */
const config = require("../dist/config").default;
const options = require("../config-test");
config.configure(options.payment);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const { $stripe, unxor, createTestMethodFromStripe } = require("../dist/payments");
const should = require("should");
const cartItems = require("./fixtures/cart.items");

function spyPaymentIntentConfirm() {
  const orig = $stripe.paymentIntents.confirm;
  const state = { called: false };
  $stripe.paymentIntents.confirm = async function () {
    state.called = true;
    return orig.apply(this, arguments);
  };
  state.restore = function () {
    $stripe.paymentIntents.confirm = orig;
  };
  return state;
}

describe("Class subscription.sca-on-session", function () {
  this.timeout(20000);

  let defaultCustomer;
  let methodFailed;
  let method3ds;
  let methodValid;

  const shipping = {
    streetAdress: "rue du rhone 69",
    postalCode: "1208",
    name: "foo bar family",
    price: 5,
    hours: 16,
    lat: 1,
    lng: 2
  };

  before(async function () {
    defaultCustomer = await customer.Customer.create("subscription.sca@email.com", "Foo", "Bar", "022345", 1234);
    methodFailed = await $stripe.paymentMethods.create({
      type: "card",
      card: { number: "4000000000000341", exp_month: 12, exp_year: 2034, cvc: "314" }
    });
    await $stripe.paymentMethods.attach(methodFailed.id, { customer: unxor(defaultCustomer.id) });

    method3ds = await $stripe.paymentMethods.create({
      type: "card",
      card: { number: "4000000000003220", exp_month: 12, exp_year: 2034, cvc: "314" }
    });
    await $stripe.paymentMethods.attach(method3ds.id, { customer: unxor(defaultCustomer.id) });

    methodValid = await $stripe.paymentMethods.create({
      type: "card",
      card: { number: "4242424242424242", exp_month: 12, exp_year: 2034, cvc: "314" }
    });
    await $stripe.paymentMethods.attach(methodValid.id, { customer: unxor(defaultCustomer.id) });
  });

  after(async function () {
    if (defaultCustomer) {
      await $stripe.customers.del(unxor(defaultCustomer.id));
    }
  });

  it("B1 create now 3220 leaves PI open (no Node confirm, mocha does not complete 3DS)", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: method3ds.id }
    });
    const spy = spyPaymentIntentConfirm();
    try {
      const items = cartItems.filter(item => item.frequency == "week");
      const contract = await subscription.SubscriptionContract.create(
        defaultCustomer,
        createTestMethodFromStripe(method3ds),
        "week",
        "now",
        items,
        { shipping, dayOfWeek: 2, fees: 0.06 }
      );
      spy.called.should.equal(false);
      should.equal(contract._subscription.default_payment_method, null);
      should.not.exist(contract.content.paymentMethod);
      should.exist(contract.content.latestPaymentIntent.client_secret);
      contract.content.status.should.equal("incomplete");
      const open3ds = ["requires_confirmation", "requires_action"];
      open3ds.should.containEql(contract.content.latestPaymentIntent.status);
      contract.content.latestPaymentIntent.status.should.not.equal("succeeded");
    } finally {
      spy.restore();
    }
  });

  it("B1 create now 4242 leaves PI open (no Node confirm)", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });
    const spy = spyPaymentIntentConfirm();
    try {
      const items = cartItems.filter(item => item.frequency == "week");
      const contract = await subscription.SubscriptionContract.create(
        defaultCustomer,
        createTestMethodFromStripe(methodValid),
        "week",
        "now",
        items,
        { shipping, dayOfWeek: 2, fees: 0.06 }
      );
      spy.called.should.equal(false);
      should.equal(contract._subscription.default_payment_method, null);
      should.exist(contract.content.latestPaymentIntent.client_secret);
      contract.content.status.should.equal("incomplete");
      contract.content.latestPaymentIntent.status.should.not.equal("succeeded");
    } finally {
      spy.restore();
    }
  });

  it("C1 update items/shipping does not re-confirm the PaymentIntent", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });
    const items = cartItems.filter(item => item.frequency == "week").map(item => Object.assign({}, item));
    let contract = await subscription.SubscriptionContract.create(
      defaultCustomer,
      createTestMethodFromStripe(methodValid),
      "week",
      "now",
      items,
      { shipping, dayOfWeek: 2, fees: 0.06 }
    );

    const pi = contract.content.latestPaymentIntent;
    if (pi && pi.status !== "succeeded") {
      // 4242 only: stand-in de confirmCardPayment, pas un parcours 3DS.
      await $stripe.paymentIntents.confirm(pi.id);
      contract = await contract.confirmPendingPayment(pi.id);
    }
    contract.content.latestPaymentIntent.status.should.equal("succeeded");
    const piId = contract.content.latestPaymentIntent.id;

    const spy = spyPaymentIntentConfirm();
    try {
      const nextShipping = Object.assign({}, shipping, { price: 8 });
      contract = await contract.update([], { shipping: nextShipping, dayOfWeek: 4, fees: 0.07 });
      spy.called.should.equal(false);
      contract.content.latestPaymentIntent.id.should.equal(piId);
      contract.content.latestPaymentIntent.status.should.equal("succeeded");
      should.equal(contract._subscription.default_payment_method, null);
    } finally {
      spy.restore();
    }
  });

  it("C1 update incomplete 3220 keeps the same PI open", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: method3ds.id }
    });
    const items = cartItems.filter(item => item.frequency == "week").map(item => Object.assign({}, item));
    let contract = await subscription.SubscriptionContract.create(
      defaultCustomer,
      createTestMethodFromStripe(method3ds),
      "week",
      "now",
      items,
      { shipping, dayOfWeek: 2, fees: 0.06 }
    );
    const piId = contract.content.latestPaymentIntent.id;
    const secret = contract.content.latestPaymentIntent.client_secret;

    const spy = spyPaymentIntentConfirm();
    try {
      const nextShipping = Object.assign({}, shipping, { price: 8 });
      contract = await contract.update([], { shipping: nextShipping, dayOfWeek: 4, fees: 0.07 });
      spy.called.should.equal(false);
      contract.content.latestPaymentIntent.id.should.equal(piId);
      contract.content.latestPaymentIntent.client_secret.should.equal(secret);
      const open3ds = ["requires_confirmation", "requires_action"];
      open3ds.should.containEql(contract.content.latestPaymentIntent.status);
    } finally {
      spy.restore();
    }
  });

  it("C4 updatePaymentMethod sets customer default and does not confirm", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });
    const items = cartItems.filter(item => item.frequency == "week");
    let contract = await subscription.SubscriptionContract.create(
      defaultCustomer,
      createTestMethodFromStripe(methodFailed),
      "week",
      "now",
      items,
      { shipping, dayOfWeek: 2, fees: 0.06 }
    );
    const openFailed = ["requires_confirmation", "requires_payment_method"];
    openFailed.should.containEql(contract.content.latestPaymentIntent.status);
    const piId = contract.content.latestPaymentIntent.id;

    const spy = spyPaymentIntentConfirm();
    try {
      contract = await contract.updatePaymentMethod(createTestMethodFromStripe(method3ds));
      spy.called.should.equal(false);
      should.equal(contract._subscription.default_payment_method, null);
      should.not.exist(contract.content.paymentMethod);
      contract.content.latestPaymentIntent.id.should.equal(piId);
      contract.content.latestPaymentIntent.status.should.not.equal("succeeded");
      should.exist(contract.content.latestPaymentIntent.client_secret);

      const stripeCustomer = await $stripe.customers.retrieve(unxor(defaultCustomer.id));
      stripeCustomer.invoice_settings.default_payment_method.should.equal(method3ds.id);
    } finally {
      spy.restore();
    }
  });

  it("C4 addMethod does not pay an open invoice", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodFailed.id }
    });
    const items = cartItems.filter(item => item.frequency == "week");
    const contract = await subscription.SubscriptionContract.create(
      defaultCustomer,
      createTestMethodFromStripe(methodFailed),
      "week",
      "now",
      items,
      { shipping, dayOfWeek: 2, fees: 0.06 }
    );
    const piId = contract.content.latestPaymentIntent.id;

    const spy = spyPaymentIntentConfirm();
    try {
      const extra = await $stripe.paymentMethods.create({
        type: "card",
        card: { number: "5555555555554444", exp_month: 12, exp_year: 2034, cvc: "314" }
      });
      await defaultCustomer.addMethod(extra.id);
      spy.called.should.equal(false);

      const refreshed = await subscription.SubscriptionContract.get(contract.id);
      refreshed.content.latestPaymentIntent.id.should.equal(piId);
      refreshed.content.latestPaymentIntent.status.should.not.equal("succeeded");
    } finally {
      spy.restore();
    }
  });

  it("B1 confirmPendingPayment does not call paymentIntents.confirm", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: methodValid.id }
    });
    const items = cartItems.filter(item => item.frequency == "week");
    const contract = await subscription.SubscriptionContract.create(
      defaultCustomer,
      createTestMethodFromStripe(methodValid),
      "week",
      "now",
      items,
      { shipping, dayOfWeek: 2, fees: 0.06 }
    );
    const pi = contract.content.latestPaymentIntent;
    should.exist(pi);

    const spy = spyPaymentIntentConfirm();
    try {
      const refreshed = await contract.confirmPendingPayment(pi.id);
      spy.called.should.equal(false);
      should.exist(refreshed.content.latestPaymentIntent);
    } finally {
      spy.restore();
    }
  });

  it("B2a create trial_end exposes pending_setup_intent (no confirmCardSetup)", async function () {
    await $stripe.customers.update(unxor(defaultCustomer.id), {
      invoice_settings: { default_payment_method: method3ds.id }
    });
    const spy = spyPaymentIntentConfirm();
    const origSetup = $stripe.setupIntents.confirm;
    let setupConfirmCalled = false;
    $stripe.setupIntents.confirm = async function () {
      setupConfirmCalled = true;
      return origSetup.apply(this, arguments);
    };
    try {
      const items = cartItems.filter(item => item.frequency == "week");
      const start = new Date(Date.now() + 7 * 86400000);
      const contract = await subscription.SubscriptionContract.create(
        defaultCustomer,
        createTestMethodFromStripe(method3ds),
        "week",
        start,
        items,
        { shipping, dayOfWeek: 2, fees: 0.06 }
      );
      spy.called.should.equal(false);
      setupConfirmCalled.should.equal(false);
      should.not.exist(contract.content.latestPaymentIntent);
      should.exist(contract.content.pendingSetupIntent);
      should.exist(contract.content.pendingSetupIntent.client_secret);
      const setupStatuses = ["requires_confirmation", "requires_action", "requires_payment_method", "succeeded"];
      setupStatuses.should.containEql(contract.content.pendingSetupIntent.status);
    } finally {
      spy.restore();
      $stripe.setupIntents.confirm = origSetup;
    }
  });
});
