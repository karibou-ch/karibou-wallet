const config = require("../dist/config").default;
const options = require("../config-test");
config.configure(options.payment);
config.option("debug", false);

const customer = require("../dist/customer");
const subscription = require("../dist/contract.subscription");
const { $stripe, unxor, card_mastercard_prepaid } = require("../dist/payments");
const should = require("should");
const cartItems = require("./fixtures/cart.items");

describe("Class subscription.creation.future-start", function() {
  this.timeout(10000);

  let defaultCustomer;
  let defaultPaymentAlias;
  let futureSub;

  const shipping = {
    streetAdress: "rue du rhone 69",
    postalCode: "1208",
    name: "foo bar family",
    price: 5,
    hours: 16,
    lat: 1,
    lng: 2
  };

  before(async function() {
    defaultCustomer = await customer.Customer.create("subscription.future@email.com", "Foo", "Bar", "022345", 1234);
    const card = await defaultCustomer.addMethod(unxor(card_mastercard_prepaid.id));
    defaultPaymentAlias = card.alias;
  });

  after(async function() {
    if (futureSub && futureSub.id) {
      await $stripe.subscriptions.cancel(unxor(futureSub.id));
    }
    if (defaultCustomer && defaultCustomer.id) {
      await $stripe.customers.del(unxor(defaultCustomer.id));
    }
  });

  it("SubscriptionContract create weekly with future startDate keeps billing_cycle_anchor", async function() {
    const fees = 0.06;
    const dayOfWeek = 2;
    const items = cartItems.filter(item => item.frequency == "week");
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const card = defaultCustomer.findMethodByAlias(defaultPaymentAlias);
    should.exist(card);

    const subOptions = { shipping, dayOfWeek, fees };
    futureSub = await subscription.SubscriptionContract.create(
      defaultCustomer,
      card,
      "week",
      futureDate,
      items,
      subOptions
    );

    should.exist(futureSub._subscription.billing_cycle_anchor);
    const expectedTimestamp = Math.floor(futureDate.getTime() / 1000);
    futureSub._subscription.billing_cycle_anchor.should.equal(expectedTimestamp);
  });
});
