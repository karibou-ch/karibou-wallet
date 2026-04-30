/**
 * Karibou payment wrapper
 * Invoice transaction with transaction coupon
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const customer = require("../dist/customer");
const default_card_invoice = require("../dist/payments").default_card_invoice;
const unxor = require("../dist/payments").unxor;
const transaction = require("../dist/transaction");
const $stripe = require("../dist/payments").$stripe;
const should = require('should');

describe("Class transaction invoice coupon", function(){
  this.timeout(8000);

  let defaultCustomer;

  const paymentOpts = {
    oid: 'invoice-coupon-01234',
    txgroup: 'AAA',
    shipping: {
      streetAdress: 'rue du rhone 69',
      postalCode: '1208',
      name: 'Invoice coupon testing family'
    }
  };

  after(async function () {
    if(defaultCustomer) {
      await $stripe.customers.del(unxor(defaultCustomer.id));
    }
  });

  it("Create customer with invoice credit enabled", async function(){
    config.option('debug', false);
    defaultCustomer = await customer.Customer.create("test-invoice-coupon@email.com","Foo","Bar","022345",1234);
    await defaultCustomer.allowCredit(true);
  });

  it("Authorize invoice with transaction coupon", async function() {
    const coupon = await $stripe.coupons.create({
      amount_off: 1000,
      currency:'CHF'
    });

    const tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, 12, {
      ...paymentOpts,
      coupon: coupon.id
    });

    tx.provider.should.equal("invoice");
    tx.status.should.equal("authorized");
    tx.amount.should.equal(12);
    tx.customerCredit.should.equal(10);
    tx.creditNote.should.equal(10);
    tx.report.credit_note.should.equal(10);
    tx._payment.metadata.coupon.should.equal(coupon.id);
    tx._payment.metadata.coupon_amount.should.equal('1000');

    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(-2);

    const openInvoice = await transaction.Transaction.fromOrder({
      status: tx.status,
      transaction: tx.id,
      issuer: tx.provider
    });
    const captured = await openInvoice.capture(12);
    captured.status.should.equal("invoice");
    captured.amount.should.equal(12);
    captured.customerCredit.should.equal(10);
    captured.creditNote.should.equal(10);
    captured.report.credit_note.should.equal(10);

    defaultCustomer = await customer.Customer.get(captured.customer);
    defaultCustomer.balance.should.equal(-2);

    const paidInvoice = await transaction.Transaction.fromOrder({
      status: captured.status,
      transaction: captured.id,
      issuer: captured.provider
    });
    const paid = await paidInvoice.capture(12);
    paid.status.should.equal("paid");
    paid.amount.should.equal(12);
    paid.customerCredit.should.equal(10);
    paid.creditNote.should.equal(10);
    paid.report.credit_note.should.equal(10);

    defaultCustomer = await customer.Customer.get(paid.customer);
    defaultCustomer.balance.should.equal(0);

    try{
      await $stripe.coupons.del(coupon.id);
      should.not.exist("dead zone");
    }catch(err){
      err.message.should.containEql('No such coupon');
    }
  });

  it("Cancel invoice coupon authorization restores only invoice debit", async function() {
    const coupon = await $stripe.coupons.create({
      amount_off: 1000,
      currency:'CHF'
    });

    const tx = await transaction.Transaction.authorize(defaultCustomer, default_card_invoice, 12, {
      ...paymentOpts,
      oid: 'invoice-coupon-cancel-01234',
      coupon: coupon.id
    });

    tx.creditNote.should.equal(10);
    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(-2);

    await tx.cancel();

    defaultCustomer = await customer.Customer.get(tx.customer);
    defaultCustomer.balance.should.equal(0);
  });
});
