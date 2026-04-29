/**
 * Karibou payment wrapper
 * Customer phone normalization
 */

const config = require("../dist/config").default;
const options = require('../config-test');
config.configure(options.payment);

const normalizePhone = require("../dist/payments").normalizePhone;

describe("customer.phone", function(){

  it("normalizePhone keeps explicit international numbers", function(){
    normalizePhone('+41 79 123 45 67').should.equal('+41791234567');
    normalizePhone('+33 7 12 34 56 78').should.equal('+33712345678');
    normalizePhone('+1 (202) 555-0123').should.equal('+12025550123');
  });

  it("normalizePhone converts explicit 00 international prefix", function(){
    normalizePhone('0041 79 123 45 67').should.equal('+41791234567');
    normalizePhone('0033 7 12 34 56 78').should.equal('+33712345678');
  });

  it("normalizePhone applies the Swiss local mobile default", function(){
    normalizePhone('079 123 45 67').should.equal('+41791234567');
    normalizePhone('07 12 34 56 78').should.equal('+41712345678');
    normalizePhone('09 12 34 56 78').should.equal('+41912345678');
  });

});
