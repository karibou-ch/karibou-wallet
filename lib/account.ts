/**
* #account.ts
* Copyright (c)2020, by olivier@karibou.ch
* Licensed under GPL license (see LICENSE)
*/

import { $stripe } from './payments';

export  class  Account {
  private _id:string;
  private _email:string;
  private _lastname:string;
  private _firstname:string;
  private _address:string;
  private _postalCode:string;
  private _city:string;
  private _company:string;

  /**
   * ## account(json)
   * @param {any} params Json serialized account object
   * @constructor
   */
  private constructor(params:any) {
    if ("email" in params) this._email = params.email;
    else throw new Error("Missing parameter: email");

    if ("id" in params) this._id = params.id;
    else throw new Error("Missing parameter: Stripe account id");

    this._lastname = params.lastname;
    this._firstname = params.firstname;
    this._address = params.address;
    this._city = params.city;
    this._postalCode = params.postalCode;
    this._company = params.company;
  }


  get id() {
    return this.id;
  }

  /**
  * ## account.create()
  * https://stripe.com/docs/connect/standard-accounts
  * Async constructor of account
  * @param {string} id
  * @returns {any} Promise for the creation of the account object
  */
  static create(id:string) {
    // return $stripe.accounts.retrieve(id).then((account) => {
    //   var custJson = JSON.stringify({
    //     id:account.id,
    //     email:account.email,
    //     lastname:account.legal_entity.last_name,
    //     firstname:account.legal_entity.first_name,
    //     address:account.legal_entity.address.line1,
    //     postalCode:account.legal_entity.address.postal_code,
    //     city:account.legal_entity.address.city,
    //     company:account.business_name
    //   });
    //   return new Account(JSON.parse(custJson));
    // }).catch(parseError);
  }

  /**
  * ## account.save()
  * Serialize the object into JSON
  * @returns {string} Account object in JSON
  */
  save() {
    return JSON.stringify(this);
  }

  /**
  * ## account.getTransferList()
  * Return the transfer's list of the account, if transferOffset is set, the list
  * begin after it.
  * @param {number} limit Number of transfer to display (1-100) default = 10
  * @param {any} transferOffset Last object of the previous transfer's list
  * @returns {any} Promise which return the list of transfer
  */
  getTransferList(limit:number=10, transferOffset?:any) {
    if (transferOffset != undefined)
      return $stripe.transfers.list({ destination:this.id, limit:limit, starting_after:transferOffset }).catch(parseError);
    else
      return $stripe.transfers.list({ destination:this.id, limit:limit }).catch(parseError);
  }

  /**
  * ## account.getId()
  * Return the id of the account
  * @returns {string} Account id
  */
  getId() {
    return this.id;
  }
}

function parseError(err) {
  throw new Error(err);
}
