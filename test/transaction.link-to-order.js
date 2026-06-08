const should = require('should');
const config = require('../dist/config').default;
const options = require('../config-test');
config.configure(options.payment);

const { Transaction } = require('../dist/transaction');
const { xor } = require('../dist/payments');

function invoicePayment(status = 'authorized', oid = '1234') {
  return {
    issuer: 'invoice',
    status,
    transaction: 'kng_' + xor(`${oid}::1000::0::cus_test::0::0`)
  };
}

describe('Transaction linkToOrder', function() {
  it('links an invoice transaction to an order without changing status', async function() {
    const tx = await Transaction.fromOrder(invoicePayment());

    await tx.linkToOrder('4321');

    tx.oid.should.equal('4321');
    tx.status.should.equal('authorized');
  });

  it('can mark the linked order as prepaid with explicit option', async function() {
    const tx = await Transaction.fromOrder(invoicePayment());

    await tx.linkToOrder('4321', { status: 'prepaid' });

    tx.oid.should.equal('4321');
    tx.status.should.equal('prepaid');
  });

});
