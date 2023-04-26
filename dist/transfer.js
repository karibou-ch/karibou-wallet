"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transfer = void 0;
const payments_1 = require("./payments");
class Transfer {
    constructor(transaction, dest) {
        this.transaction = transaction;
        this.dest = dest;
        for (let i in dest) {
            this.dest[i].transferId = undefined;
            this.dest[i].amountRefunded = 0;
            this.dest[i].logs = [];
        }
    }
    static load(params) {
        var newTransfer = new Transfer(params.transaction, params.dest);
        newTransfer.dest = params.dest;
        return newTransfer;
    }
    save() {
        return JSON.stringify(this);
    }
    execute() {
        var promiseList = [];
        var errorTransferId = [];
        if (!this.transaction.captured) {
            return Promise.reject(new Error("Transaction must be captured before any transfer."));
        }
        if (this.transaction.amount !== 0) {
            return Promise.reject(new Error("Transaction must not have been refunded before transfers"));
        }
        return payments_1.$stripe.transfers.list({ transfer_group: this.transaction.group, limit: 100 })
            .then((transferList) => {
            for (let i in this.dest) {
                if (this.dest[i].transferId === undefined) {
                    var ok = true;
                    for (let j in transferList.data) {
                        if (transferList.data[j].destination === this.dest[i].account.id) {
                            ok = false;
                            break;
                        }
                    }
                    if (ok) {
                        promiseList.push(payments_1.$stripe.transfers.create({
                            amount: this.dest[i].amount,
                            currency: "chf",
                            destination: this.dest[i].account.id,
                            transfer_group: this.transaction.group,
                            source_transaction: this.transaction.id
                        }).then((transferStripe) => {
                            var date = new Date(transferStripe.created * 1000);
                            this.dest[i].transferId = transferStripe.id;
                            this.dest[i].logs.push(date.toISOString() + " : " + transferStripe.amount
                                + " transferred to " + transferStripe.destination);
                        }));
                    }
                }
                else {
                    var index = transferList.data.findIndex((tmp) => { return tmp.id === this.dest[i].transferId; });
                    if (index < 0) {
                        errorTransferId.push(this.dest[i].transferId);
                    }
                }
            }
            if (errorTransferId.length <= 0) {
                return Promise.all(promiseList).catch(parseError);
            }
            else {
                return Promise.reject(new Error("Transfer(s) " + errorTransferId.toString() +
                    " don't exist in the groupId " + this.transaction.group));
            }
        });
    }
    refund(account, description, amount) {
        var index = this.dest.findIndex((tmp) => { return tmp.account.id === account.id; });
        if (index === undefined) {
            return Promise.reject(new Error("Account for the transfer not found."));
        }
        if (this.dest[index].transferId === undefined) {
            return Promise.reject(new Error("Transfer not done."));
        }
        if (amount === undefined) {
            amount = this.dest[index].amount - this.dest[index].amountRefunded;
        }
        if (this.dest[index].amount - this.dest[index].amountRefunded < amount) {
            return Promise.reject(new Error("Refund impossible the amount is bigger than the one left."));
        }
        return payments_1.$stripe.transfers.createReversal(this.dest[index].transferId, { amount: amount })
            .then((refund) => {
            var date = new Date(refund.created * 1000);
            this.dest[index].amountRefunded += refund.amount;
            this.dest[index].logs.push(date.toISOString() + " : " + refund.amount
                + " refunded, reason: " + description);
        }).catch(parseError);
    }
    refundAll(description) {
        var promiseList = [];
        for (let i in this.dest) {
            if ((this.dest[i].transferId !== undefined) && (this.dest[i].amount > this.dest[i].amountRefunded))
                promiseList.push(payments_1.$stripe.transfers.createReversal(this.dest[i].transferId)
                    .then((refund) => {
                    var date = new Date(refund.created * 1000);
                    this.dest[i].amountRefunded = refund.amount;
                    this.dest[i].logs.push(date.toISOString() + " : " + refund.amount
                        + " refunded, reason: " + description);
                }));
        }
        return Promise.all(promiseList).catch(parseError);
    }
    getState(account) {
        for (let i in this.dest) {
            if (account.id === this.dest[i].account.id)
                return this.dest[i];
        }
    }
}
exports.Transfer = Transfer;
function parseError(err) {
    throw new Error(err);
}
//# sourceMappingURL=transfer.js.map