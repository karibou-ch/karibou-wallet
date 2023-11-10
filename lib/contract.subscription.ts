import { strict as assert } from 'assert';
import Stripe from 'stripe';
import { Customer } from './customer';
import { $stripe, KngPaymentAddress, KngCard, unxor, xor, KngPaymentSource, round1cts } from './payments';
import Config from './config';

//
// using memory cache limited to 1000 customer in same time for 4h
const cache = new (require("lru-cache").LRUCache)({ttl:1000 * 60 * 60 * 4,max:1000});
const locked = new (require("lru-cache").LRUCache)({ttl:3000,max:1000});

export type Interval = Stripe.Plan.Interval;

export interface SubscriptionProductItem{
  id: string,
  unit_amount: number,
  currency:string,
  quantity:number,
  fees:number,
  sku:number|string,
  title:string,
  note: string,
  hub: string,
  part: string,
  variant?:string
}

export interface SubscriptionServiceItem{
  unit_amount:number,
  quantity:number,
  fees?:Number,
  id:string
}


export enum SchedulerStatus {
  active = "active", 
  paused="paused", 
  pending="pending", 
  incomplete="incomplete", 
  trialing="trialing",
  cancel="cancel"
}


export type SchedulerItemFrequency = 0|"day"|"week"|"2weeks"|"month"|string;


export interface SubscriptionAddress extends KngPaymentAddress {
  price?:number;
}
  
//
// subscription is available for product with shipping, and for service only
export interface Subscription {
  id:string;
  plan:"service"|"customer"|"business"|"patreon"|string;
  customer: string;// as karibou id
  description: string;
  start:Date;
  nextInvoice:Date;
  pauseUntil: Date|0;
  frequency:SchedulerItemFrequency;
  status:string;
  latestPaymentIntent:any;
  issue?:string;
  fees?:number;
  dayOfWeek?:number;
  shipping?: SubscriptionAddress;
  patreon: SubscriptionServiceItem[];
  services: SubscriptionServiceItem[];
  items?: SubscriptionProductItem[];
};


export interface SubscriptionOptions {
  dayOfWeek?:number,
  price:number;
  shipping?: SubscriptionAddress
}

//
// internal description
// when item is a service, sku define the id (logistic, karibou.ch or others)
interface SubscriptionMetaItem {
  type:"product"|"service",
  sku: string|number;
  quantity:number;
  title : string;
  part? : string;
  variant? : string;
  hub? : string;
  note? : string;
  fees : string|number;
}

// Unit amount is a positive integer in cents 
interface SubscriptionItem {
  id?:string;
  currency:string;
  unit_amount:number; 
  product:string;
  recurring:{
    interval:Interval;
    interval_count: number;
  }
  metadata?:SubscriptionMetaItem;
}

/** 
  contractId
  - 8 days start from X
  - 12 weeks start from Y
  - 16 month start from Z
  status: active, pending, closed, paused */
export class SubscriptionContract {

  private _subscription: Stripe.Subscription; 
  private _interval:Interval;
  private _interval_count:number;

  private constructor(subs:Stripe.Subscription) {
    this._subscription = subs;
    this._interval = this._subscription.items.data[0].plan.interval;
    this._interval_count = this._subscription.items.data[0].plan.interval_count;

    const contracts = cache.get(xor(subs.customer.toString())) || [];
    if(!contracts.some(contract => contract.id == this.id)){
      contracts.push(this);
    }

    cache.set(this._subscription.id,this);
  }

  get id () { return xor(this._subscription.id) }
  get interval () { 
    const today = new Date();
    const frequency = (this._interval=='week' && this._interval_count==2)? '2weeks':this._interval;

    let anchor = new Date(this._subscription.billing_cycle_anchor * 1000);

    let nextBilling = new Date();
    if(anchor>nextBilling) {
      nextBilling = anchor;
    }


    //
    // week case next billing is always 3 days before the shipping
    // - Saturday for Tuesday (mar 2)
    // - Sunday for Wednesday (mer 3)
    // - Monday for Thusday (jeu 4)
    // FIXME nextInvoice depends on pauseUntil and the dayOfWeek
    if(frequency == "week"){
      nextBilling.setDate(nextBilling.getDate() + 7);
    }

    if(frequency == "2weeks"){
      nextBilling.setDate(nextBilling.getDate() + 14);
    }

    //
    // month case next billing is always the same day
    if(frequency == "month"){
      nextBilling = new Date(this.billing_cycle_anchor);
      nextBilling.setMonth(nextBilling.getMonth()+1);
    }

    //
    // if contract is paused
    nextBilling = this.pausedUntil || nextBilling;
    nextBilling.setHours(anchor.getHours());
    nextBilling.setMinutes(anchor.getMinutes());


    return {
      frequency,
      start:this.billing_cycle_anchor,
      count:this._interval_count,
      dayOfWeek: +this._subscription.metadata.dayOfWeek,
      nextBilling
    } 
  }
  
  get environnement() {
    return this._subscription.metadata.env||'';
  }

  get latestPaymentIntent() {
    const invoice = this._subscription.latest_invoice as Stripe.Invoice;
    if(!invoice.payment_intent) {
      return null;
    }
    const paymentIntent = invoice.payment_intent as Stripe.PaymentIntent
    return {source:paymentIntent.payment_method, status:paymentIntent.status,id:paymentIntent.id,client_secret:paymentIntent.client_secret};
  }

  //
  // https://stripe.com/docs/api/subscriptions/object#subscription_object-status
  get status () { 
    if(this._subscription.pause_collection) {
      return 'paused';
    }
    //
    // canceled or paused, incomplete, incomplete_expired, trialing, active, past_due, unpaid.
    const stripeStatus = this._subscription.status.toString();
    switch(stripeStatus){
      case "incomplete":
      case "unpaid":
      case "incomplete_expired":
      case "past_due":
      return "incomplete";
      default:
      return stripeStatus;
    } 
  }
  get content ():Subscription { 
    const frequency = (this.interval.frequency)

    // 
    // subscription can have the simplest form without product items
    const description = (this._subscription.description)? this._subscription.description.toString():"";
    const result:Subscription = {
      id: (this.id),
      customer: this._subscription.metadata.uid,
      start:this.interval.start,
      pauseUntil: this.pausedUntil,
      nextInvoice: this.interval.nextBilling,
      frequency,
      status:this.status,
      issue:this._subscription.status.toString(),
      patreon:this.patreonItems,
      items:[],
      services: this.serviceItems,
      plan:this._subscription.metadata.plan||"service",
      latestPaymentIntent:this.latestPaymentIntent,
      description
    }

    // 
    // subscription for product items with shipping
    if(this._subscription.metadata.address){
      result.dayOfWeek = (+this._subscription.metadata.dayOfWeek);
      result.shipping = this.shipping;
      result.plan = this._subscription.metadata.plan||"customer";
      result.fees = parseFloat(this._subscription.metadata.fees)
      result.items = this.items;
    }

    return result;
  }

  get pausedUntil(): Date|0 {
    if(this._subscription.pause_collection && this._subscription.pause_collection.resumes_at) {
      return new Date(this._subscription.pause_collection.resumes_at * 1000 );
    }
    return 0;
  }
  //
  // return the delivery shippping and date for which the subscription is scheduled
  get shipping ():SubscriptionAddress {
    if(!this._subscription.metadata.address){
      return {} as SubscriptionAddress;
    }
    return parseShipping(this._subscription.metadata);
  }

  get paymentMethod() {
    if(this._subscription.metadata.payment_credit){
      return this._subscription.metadata.payment_credit;
    }
    if( this._subscription.default_payment_method) {
      return xor(this._subscription.default_payment_method as string);
    }
    throw new Error("Invalid payment method in subscript "+this.id);
  }

  get paymentCredit() {
    return this._subscription.metadata.payment_credit;
  }

  //
  // configure the billing cycle anchor to fixed dates (for example, the 1st of the next month).
  // For example, a customer with a monthly subscription set to cycle on the 2nd of the 
  // month will always be billed on the 2nd.
  get billing_cycle_anchor():Date {
    return new Date(this._subscription.billing_cycle_anchor * 1000 );
  }

  get items():SubscriptionProductItem[]{
    const elements = this._subscription.items.data.filter(item => item.metadata.type == 'product');
    return elements.map(parseItem);
  }

  get serviceItems():SubscriptionServiceItem[]{
    const elements = this._subscription.items.data.filter(item => item.metadata.type == 'service').map(parseServiceItem);
    return elements;
  }

  get patreonItems():SubscriptionServiceItem[]{
    const elements = this._subscription.items.data.filter(item => item.metadata.type == 'patreon').map(parseServiceItem);
    return elements;
  }

  //
  // update the billing_cycle_anchor to now.
  // UPDATE: to avoid days overlapping between shipping 
  // and billing (shipping is ALWAYS made days or the week after billing)
  // 
  // DEPRECATED
  // https://stripe.com/docs/billing/subscriptions/billing-cycle#changing
  // async updateNextInvoiceDay() {
  //   const customer = this._subscription.customer as string;
  //   const subscription = await $stripe.subscriptions.update(
  //     customer,
  //     {billing_cycle_anchor: 'now', proration_behavior: 'none'}
  //   );
  // }

  findOneItem(sku){
    const items = this._subscription.items.data||[];
    return items.find(item=> item.metadata.sku == sku);
  }

  async customer(){
    try{
      return await Customer.get(this._subscription.customer);
    }catch(err){
      return {deleted:true} as Customer;
    }
  }

  //
  // Cancel (delete) subscription at end of (paid) cycle
  // that is, for the duration of time the customer has already paid for
  // https://stripe.com/docs/billing/subscriptions/cancel?dashboard-or-api=api#cancel-at-end-of-cycle
  async cancel(){
    // https://stripe.com/docs/billing/subscriptions/cancel?dashboard-or-api=api
    // cancel_at_period_end: true
    this._subscription = await $stripe.subscriptions.cancel(
      this._subscription.id,{ expand:['latest_invoice.payment_intent']}
    );

    cache.set(this._subscription.id,this);
    return this;
  }

  //
  // set the subscription on pause, 
  // sub will pause on {from} Date ({from} billing must be aligned with the billing_cycle_anchor to avoid confusion)
  // sub will resume on {to} Date ({to} billing must be aligned 2-3 days before the dayOfWeek delivery) 
  // https://stripe.com/docs/billing/subscriptions/pause
  async pause(to:Date, from?:Date) {
    const metadata = this._subscription.metadata;

    // Stripe won’t send any upcoming invoice emails or webhooks for these invoices 
    // and the subscription’s status remains unchanged.
    const behavior:any ={
      behavior: 'void'
    }
    //
    // be sure (in frontend) that resume time is 2-3 days before the next shipping day
    if (to){
      if(!to.toDateString) throw new Error("resume date is incorrect");
      behavior.resumes_at=parseInt(to.getTime()/1000+'');
    }
    //
    // get optional from
    // FIXME we need planning for pause
    // from = (from && from.getTime())? (from) : (new Date());
    // metadata.from = from.getTime()+'';

    this._subscription = await $stripe.subscriptions.update(
      this._subscription.id,
      {pause_collection: behavior, expand:['latest_invoice.payment_intent']}
    );

    cache.set(this._subscription.id,this);
  }


  async resumeManualy(){
    const metadata = this._subscription.metadata;
    metadata.from = null;
    metadata.to = null;
    this._subscription = await $stripe.subscriptions.update(
      this._subscription.id, {pause_collection: '', metadata, expand:['latest_invoice.payment_intent']}
    );

    cache.set(this._subscription.id,this);

  }


  //
  // validate required action (3ds)
  // 2. payment intent is confirmed and/or card is updated

  // 
  // Update current contract with the new customer payment method 
  async updatePaymentMethod(card:KngCard) {
    let paymentIntent = this.latestPaymentIntent;
    if(!paymentIntent) {
      throw new Error("Missing payment intent");
    }
    if(!card || !card.id) {
      throw new Error("Missing payment method");
    }

    const tid = paymentIntent.id;
    await $stripe.paymentIntents.confirm(tid,{
      payment_method:unxor(card.id)
    });
    
    this._subscription = await $stripe.subscriptions.retrieve((this._subscription.id),{expand:['latest_invoice.payment_intent']}) as any;

    cache.set(this._subscription.id,this);

    return this;
  }

  async confirmPendingPayment(tid){
    //
    // use update instead confirm() throw err: You cannot confirm this PaymentIntent because it has already succeeded after being previously confirmed
    await $stripe.paymentIntents.update(tid);
    this._subscription = await $stripe.subscriptions.retrieve((this._subscription.id),{expand:['latest_invoice.payment_intent']}) as any;
    cache.set(this._subscription.id,this);
    return this;
  }

  static fromWebhook(stripe) {
    return new SubscriptionContract(stripe); 
  }


  static async createOnlyFromService(customer:Customer, card:KngPaymentSource, interval:SchedulerItemFrequency,  product) {
    const isInvoice = card.issuer == "invoice";
    const quantity = 1;
    const price = product.default_price.unit_amount;

    const _method = 'createOnlyFromService'+customer.id;
    lock(_method);
    try{
      //
      // create metadata karibou model
      // https://github.com/karibou-ch/karibou-api/wiki/1.4-Paiement-par-souscription
      const metadata:any = { uid:customer.uid, plan:'patreon' };

      //
      // avoid webhook
      if(process.env.NODE_ENV=='test'){
        metadata.env="test";
      }

      //
      // missing fees (see documentation for fees inclusion)
      // warning unit_amount is positive integer in cents 
      const recurring = (interval=='2weeks')? ({interval:('week' as Interval),interval_count:2}):({interval:(interval as Interval),interval_count:1})

      const serviceItem:SubscriptionItem = { 
        currency : 'CHF', 
        unit_amount : isInvoice? 0:(price),
        product : product.id,
        recurring
      };
      const itemMetadata = {
        type:"patreon",
        title: product.name,
        quantity,
      }

      const items = [{metadata:itemMetadata, quantity,price_data:serviceItem}];    

      const description = product.description;
      // FIXME, manage SCA or pexpired card in subscription workflow
      // https://stripe.com/fr-ch/guides/strong-customer-authentication#exemptions-de-lauthentification-forte-du-client
      //
      // payment_behavior for 3ds or expired card 
      // - allow_incomplete accept subscript delegate the payment in external process
      // - default_incomplete same as allow_incomplete with a limit of 23 hours (status=incomplete_expired)
      // Testing
      // - https://stripe.com/docs/billing/testing
      // - https://stripe.com/docs/billing/subscriptions/build-subscriptions?ui=elements#test
      // - https://stripe.com/docs/billing/subscriptions/overview#subscription-lifecycle


      //
      // with 'default_incomplete' the subscription is deleted after 24h without payment confirmation
      // without billing_cycle_anchor l’abonnement sera facturé le dernier jour du mois.
      const billing_cycle_anchor = (Date.now()+1000)/1000|0;
      const options = {
        customer: unxor(customer.id),
        payment_behavior:'default_incomplete',
        off_session:false,
        description,
        proration_behavior:'none',
        items,
        metadata 
      } as Stripe.SubscriptionCreateParams;

      //
      // payment method
      // use invoice default_pament_method for Stripe 
      if(card.issuer=="invoice") {
        metadata.payment_credit=card.id;
        options.payment_behavior = 'allow_incomplete';
        options.payment_settings = {}
      } else {
        options.payment_behavior = 'default_incomplete';
        options.payment_settings = { save_default_payment_method: 'on_subscription' };
        options.default_payment_method=unxor(card.id);
        options.expand = ['latest_invoice.payment_intent']
      }

      //
      // https://stripe.com/docs/billing/testing
      let subscription = await $stripe.subscriptions.create(options);  
      
      //
      // WRONG status pending setup_intent 
      // const setup_intent = subscription.pending_setup_intent as Stripe.SetupIntent;

      // if(setup_intent) {
      //   const setupDone = await $stripe.setupIntents.confirm(setup_intent.id);
      //   subscription = await $stripe.subscriptions.retrieve(subscription.id,{expand:['latest_invoice.payment_intent']});
      // }
      const invoice = subscription.latest_invoice  as Stripe.Invoice;
      const invoice_intent = invoice && invoice.payment_intent as Stripe.PaymentIntent;

      if(invoice_intent ) {
        //
        // refused payment method trow an Error()
        try{
          const transaction = await $stripe.paymentIntents.confirm(invoice_intent.id);  
          subscription.latest_invoice = subscription.latest_invoice ||{} as Stripe.Invoice;
          subscription.latest_invoice['payment_intent'] = transaction;
          subscription = await $stripe.subscriptions.retrieve(subscription.id,{expand:['latest_invoice.payment_intent']});
        }catch(err) { 
          if (!err.payment_intent){
            throw err;
          }
          subscription.latest_invoice = subscription.latest_invoice ||{} as Stripe.Invoice;
          subscription.latest_invoice['payment_intent'] = err.payment_intent;            
        }
      }
      return new SubscriptionContract(subscription);  
    }catch(err){
      throw parseError(err);
    }finally{
      unlock(_method);
    }



  }

  //
  // create one subscription by recurring interval (day, week, 2weeks, month)
  // https://stripe.com/docs/api/subscriptions
  //
  // - check status and content of subscription before to create a new one
  // - check that cart id exist and bellongd to this customer
  // - allow_incomplete, pending_if_incomplete or error_if_incomplete
  //   https://stripe.com/docs/api/subscriptions/create#create_subscription-payment_behavior
  // - collection_method = charge_automatically or send_invoice
  // - days_until_due, Number of days a customer has to pay invoices
  //
  //
  // - multiple subscription for 
  //   https://stripe.com/docs/billing/subscriptions/multiple-products#multiple-subscriptions-for-a-customer
  //   note: use the same billing_cycle_anchor for the same customer
  static async create(customer:Customer, card:KngPaymentSource, interval:SchedulerItemFrequency, start_from,  cartItems, subscriptionOptions) {
    
    // check Date instance
    // timestamp: must be an integer Unix timestamp [getTime()/1000]
    assert(start_from=='now' || (start_from && start_from.getTime()));

    const {shipping, dayOfWeek, fees, plan} = subscriptionOptions;
    assert(fees>=0)
    const _method = 'create'+customer.id;
    lock(_method);
    
    //
    // validate start_from when interval is month
    // FIXME avoid billing error we need to know any error 3 days before the shipping


    try{
      //
      // validate fees range [0..1]
      if((fees>1) || (fees <0)) {
        throw new Error("Incorrect fees params");
      }
      // in case of shipping
      if(shipping) {
        assert(shipping.price>=0);
        assert(shipping.hours>=0);
        assert(dayOfWeek>=0);
      }

      //
      // filter cartItems for services or products
      const cartServices = cartItems.filter(item => !item.sku);
      cartItems = cartItems.filter(item => !!item.sku);

      if(!shipping && cartItems.length){
        throw new Error("Shipping address is mandatory with products");      
      }

      if (!cartServices.length && !cartItems.length) {
        throw new Error("Missing items");            
      }

      //
      // create stripe products
      if(cartItems.some(item => !item.frequency)){
        throw new Error("incorrect item format (L:601)");
      }

      //
      // build items based on user cart
      const itemsOptions = {
        invoice:(card.issuer=='invoice'), 
        interval, 
        serviceFees:fees,
        shipping
      }

      const {items, contractShipping } = await createContractItemsForShipping(null,cartServices, cartItems, itemsOptions);

      //
      // be sure
      // assert(servicePrice>0);

      //
      // create metadata karibou model
      // https://github.com/karibou-ch/karibou-api/wiki/1.4-Paiement-par-souscription
      const metadataPlan = plan ||((cartItems.length)?'customer':'service');
      const metadata:any = { uid:customer.uid, fees,plan: metadataPlan};

      //
      // use clean shipping with price included
      if(contractShipping) {
        metadata.address = JSON.stringify(contractShipping,null,0);
        metadata.dayOfWeek = dayOfWeek
      }

      //
      // avoid webhook
      if(process.env.NODE_ENV=='test'){
        metadata.env="test";
      }


      const description = "contrat:" + interval + ":"+ customer.uid;
      // FIXME, manage SCA or pexpired card in subscription workflow
      // https://stripe.com/fr-ch/guides/strong-customer-authentication#exemptions-de-lauthentification-forte-du-client
      //
      // payment_behavior for 3ds or expired card 
      // - allow_incomplete accept subscript delegate the payment in external process
      // - default_incomplete same as allow_incomplete with a limit of 23 hours (status=incomplete_expired)
      // Testing
      // - https://stripe.com/docs/billing/testing
      // - https://stripe.com/docs/billing/subscriptions/build-subscriptions?ui=elements#test
      // - https://stripe.com/docs/billing/subscriptions/overview#subscription-lifecycle


      //
      // with 'default_incomplete' the subscription is deleted after 24h without payment confirmation
      // BUT, default_incomplete explicitly defers the payment 
      const options = {
        customer: unxor(customer.id),
        payment_behavior:'default_incomplete',
        off_session:false,
        description,
        proration_behavior:'none',
        items:items,
        metadata 
      } as Stripe.SubscriptionCreateParams;

      // 3 days before the 1st tuesday of the next week/month    
      if(start_from=='now') {
        //options.billing_cycle_anchor = (Date.now()+1000)/1000|0;
      }else {
        //
        // start from generate a setup_intents instead of payment_intents
        //options.billing_cycle_anchor = (start_from.getTime()/1000)|0;
      }

      //
      // payment method
      // use invoice default_pament_method for Stripe 
      if(card.issuer=="invoice") {
        metadata.payment_credit=card.id;
        options.payment_behavior = 'allow_incomplete';
        options.payment_settings = {}
      } else {

        //
        // default_payment_method [4], then you can use different payment_behavior (allow_incomplete) to allow an initial 
        // payment attempt immediately and handle potential actions only, if required.
        options.payment_behavior = 'default_incomplete';
        options.payment_settings = { save_default_payment_method: 'on_subscription' };
        options.default_payment_method=unxor(card.id);
        options.expand = ['latest_invoice.payment_intent']
      }

      //
      // https://stripe.com/docs/billing/testing
      let subscription = await $stripe.subscriptions.create(options);  
      
      //
      // always confirm pending invoice
      // this will update the latest_invoice ?
      const now = Date.now();
      //
      // WRONG status pending setup_intent 
      // const setup_intent = subscription.pending_setup_intent as Stripe.SetupIntent;

      // if(setup_intent) {
      //   const setupDone = await $stripe.setupIntents.confirm(setup_intent.id);
      //   subscription = await $stripe.subscriptions.retrieve(subscription.id,{expand:['latest_invoice.payment_intent']});
      // }
      const invoice = subscription.latest_invoice  as Stripe.Invoice;
      const invoice_intent = invoice && invoice.payment_intent as Stripe.PaymentIntent;

      if(invoice_intent ) {
        //
        // refused payment method trow an Error()
        try{
          const transaction = await $stripe.paymentIntents.confirm(invoice_intent.id);  
          subscription.latest_invoice = subscription.latest_invoice ||{} as Stripe.Invoice;
          subscription.latest_invoice['payment_intent'] = transaction;
          subscription = await $stripe.subscriptions.retrieve(subscription.id,{expand:['latest_invoice.payment_intent']});
        }catch(err) { 
          if (!err.payment_intent){
            throw err;
          }
          subscription.latest_invoice = subscription.latest_invoice ||{} as Stripe.Invoice;
          subscription.latest_invoice['payment_intent'] = err.payment_intent;            
        }
      }
     

      //
      //
      // this.content.paymentIntent
      // At this moment (SCA Life cycle)
      // - payment can be pending (SCA auth, or other situation) 
      // - With the value subscription.pending_setup_intent (as Stripe.SetupIntent)
      // A) IF status === "requires_action"   
      // - Frontend should confirm 
      //   $stripe.confirmCardSetup(intent.client_secret)
      //   - Display error.message in your UI.
      //   - The setup has succeeded.
      // B) IF status === "requires_payment_method"
      // - Frontend - Customer collect new payment method (an other SCA Lifecycle)
      //   $stripe.confirmCardSetup(intent.client_secret)
      //   On success, inform K.API for the new payment (subscription.updatePaymentMethod)
      //   On Error, inform K.API the subscription is cancel
      //   After a while, subscription is deleted
      return new SubscriptionContract(subscription);  
    }catch(err) {
      throw parseError(err);
    }finally{
      unlock(_method);
    }
  }

  //
  // update the contract with  karibou cart items
  // replaces the previous contract with the new items and price 
  // https://stripe.com/docs/billing/subscriptions/upgrade-downgrade
  async update(upItems, subscriptionOptions) {
    const _method = 'updateContract'+upItems.length;
    lock(_method);

    const {shipping, dayOfWeek, fees} = subscriptionOptions;
    assert(fees>=0)
    
    try{
      
      // 1. update all the contract

      //
      // validate fees range [0..1]
      if((fees>1) || (fees <0)) {
        throw new Error("Incorrect fees params");
      }
      // in case of shipping
      if(shipping) {
        assert(shipping.price>=0);
        assert(dayOfWeek>=0);
      }

      //
      // filter cartItems for services or products
      const cartServices = upItems.filter(item => !item.sku);
      let cartItems = upItems.filter(item => !!item.sku);

      //
      // check available items for update
      if(!cartItems.length) {
        cartItems = this.content.items;
        cartItems.forEach(item => {
          item.frequency=this.interval.frequency;
          item.price=item.fees;
        });
      }

      if(!shipping && cartItems.length){
        throw new Error("Shipping address is mandatory with products");      
      }

      if (!cartServices.length && !cartItems.length) {
        throw new Error("Missing items");            
      }

      //
      // create stripe products
      if(cartItems.some(item => (item.frequency!=this.interval.frequency||!(item.price>=0)))){
        throw new Error("incorrect item format");
      }

      //
      // prepare items for update
      cartItems.forEach(item => {
        const available = this.findOneItem(item.sku);
        if(available) {
          item.id = available.id;
          item.product = available.price.product;  
        }
      })

      //
      // build items based on user cart
      const itemsOptions = {
        invoice:!!this.paymentCredit, 
        interval:this.interval.frequency,
        serviceFees:fees,
        shipping
      }

      const {items, servicePrice, contractShipping } = await createContractItemsForShipping(this,cartServices, cartItems, itemsOptions);

      const metadata = this._subscription.metadata;

      (fees>=0) && (metadata.fees = fees);      
      (dayOfWeek>=0) && (metadata.dayOfWeek = dayOfWeek);

      //
      // use clean shipping
      if(contractShipping) {
        metadata.address = JSON.stringify(contractShipping,null,0);
      }

      //
      // remove previous service items
      // items.id => Subscription item to update
      // items.deleted => A flag that, if set to true, will delete the specified item.
      // const deleted = this._subscription.items.data.filter(item => item.metadata.type=='service').map(item=> ({id:item.id,deleted:true}));

      const options = {
        items:items,
        metadata,
        expand : ['latest_invoice.payment_intent']
      } as Stripe.SubscriptionUpdateParams;


      let subscription = await $stripe.subscriptions.update(
        unxor(this.id),
        options
      );
      
      const invoice = subscription.latest_invoice  as Stripe.Invoice;
      const invoice_intent = invoice && invoice.payment_intent as Stripe.PaymentIntent;

      if(invoice_intent ) {
        //
        // refused payment method trow an Error()
        try{
          const transaction = await $stripe.paymentIntents.confirm(invoice_intent.id);  
          subscription.latest_invoice = subscription.latest_invoice ||{} as Stripe.Invoice;
          subscription.latest_invoice['payment_intent'] = transaction;
          subscription = await $stripe.subscriptions.retrieve(subscription.id,{expand:['latest_invoice.payment_intent']});
        }catch(err) { 
          if (!err.payment_intent){
            throw err;
          }
          subscription.latest_invoice = subscription.latest_invoice ||{} as Stripe.Invoice;
          subscription.latest_invoice['payment_intent'] = err.payment_intent;            
        }
      }
       
      this._subscription = subscription;
      cache.set(this._subscription.id,this);
      return this;
    }catch(err){
      throw parseError(err);
    }finally{
      unlock(_method);
    }

  }


  static clearCache(id) {
    // use the stripe id
    id = id.indexOf('sub_')>-1? id: unxor(id);
    cache.delete(id);
  }

  /**
  * ## subscriptionContract.get()
  * @returns a Contract instance with all context data in memory
  */
   static async get(id) {

    // use the stripe id
    id = id.indexOf('sub_')>-1? id: unxor(id);

    const incache = cache.get(id);
    if(incache) {
      return incache;
    }

    try{
      const stripe = await $stripe.subscriptions.retrieve(id,{expand:['latest_invoice.payment_intent']}) as any;
      const subscription = new SubscriptionContract(stripe); 
      return subscription;
    }catch(err) {
      throw parseError(err);
    } 
  }

  //
  // update a subscription when item price has changed
  // -- https://stripe.com/docs/billing/subscriptions/pending-updates#update-subscription


  //
  // manage souscription from webhook or customer action
  // https://stripe.com/docs/billing/subscriptions/webhooks#events
  // main events,
  // - customer.subscription.paused	
  // - customer.subscription.resumed	
  // - customer.subscription.updated	
  // - payment_intent.created	
  // - payment_intent.succeeded	

  //
  // load all subscript for this customer
  // - format content for customer presentation 
  static async list(customer:Customer) {
    const incache = cache.get(customer.id);
    if(incache) {
      return incache;
    }



    // constraint subscription by date {created: {gt: Date.now()}}
    const subscriptions:Stripe.ApiList<Stripe.Subscription> = await $stripe.subscriptions.list({
      customer:unxor(customer.id) , expand:['data.latest_invoice.payment_intent']
    });

    const contracts = subscriptions.data.map(sub => new SubscriptionContract(sub));
    cache.set(customer.id,contracts);

    //
    // wrap stripe subscript to karibou 
    return contracts;
  }

  //
  // active, unpaid, incomplete, paused
  // price: product.default_price.id
  static async listAll(options) {
    if(!options.status && !options.price ) {
      throw new Error("Subscription list params error");
    }
    // constraint subscription by date {created: {gt: Date.now()}}
    const subscriptions:Stripe.ApiList<Stripe.Subscription> = await $stripe.subscriptions.list(options);

    //
    // wrap stripe subscript to karibou 
    return subscriptions.data.map(sub => new SubscriptionContract(sub))

  }  

  static async listAllPatreon() {
    const query = {
      query: 'status:\'active\' AND metadata[\'plan\']:\'patreon\'',
    }
    // constraint subscription by date {created: {gt: Date.now()}}
    const subscriptions:Stripe.ApiSearchResult<Stripe.Subscription> = await $stripe.subscriptions.search(query);
    //
    // wrap stripe subscript to karibou 
    return subscriptions.data.map(sub => new SubscriptionContract(sub))

  }  

  static async listProducts() {
    const products = await $stripe.products.search({
      query:"active:'true' AND name~'patreon'", limit:10,expand:['data.default_price']
    })
    return products.data;
  }
}

//
// prepare items for shipping, service or others
async function createContractItemsForShipping(contract, cartServices, cartItems, options) {
    const isInvoice = options.invoice;

    // check is subscription must be updated or created
    for(let item of cartItems) {
      if(item.product) {
        continue;
      }
      item.product = await findOrCreateProductFromItem(item);
    }
    // group items by interval, day, week, month
    const items = createItemsFromCart(cartItems,options.interval,isInvoice);

    //
    // compute service serviceFees
    const servicePrice = cartItems.filter(item => !item.deleted).reduce((sum, item) => {
      return sum + (item.price * item.quantity * (options.serviceFees));
    }, 0)

    //
    // create items for service fees and shipping
    if(cartItems.length&&servicePrice>=0) {
      const item = {
        id:'service',
        title:'karibou.ch',
        price:round1cts(servicePrice),
        quantity:1        
      }

      // check is subscription must be updated or created
      let product, stripe_id;
      if (contract){
        const stripeItem = contract.findOneItem('service','karibou.ch');        
        product = stripeItem.price.product;
        stripe_id = stripeItem.id;
      }

      const itemService:any = await findOrCreateItemService(product,item,options.interval, isInvoice);
      (stripe_id) && (itemService.id = stripe_id);
      items.push(itemService);  
    }
    // check for delete item
    else{
      let product, stripe_id;
      if (contract){
        const stripeItem = contract.findOneItem('service','karibou.ch');        
        stripe_id = stripeItem.id;
      }
      if(stripe_id){
        const itemService:any = {id:stripe_id,deleted:true};
        items.push(itemService);    
      }
    }

    //
    // create items for service only
    if(cartServices.length) {
      for(let elem of cartServices) {
        const item = {
          id:(elem.sku||elem.id),
          title:elem.title,
          price:elem.price,
          quantity:elem.quantity        
        }  

        // check is subscription must be updated or created
        let product, stripe_id;
        if (contract){
          const stripeItem = contract.findOneItem('service');        
          product = stripeItem.price.product;
          stripe_id = stripeItem.id;
        }

        const itemService:any = await findOrCreateItemService(product,item,options.interval, isInvoice);
        (stripe_id) && (itemService.id = stripe_id);
        (elem.deleted) && (itemService.deleted = true);
        items.push(itemService);  
      }

    }  

    //
    // create shipping item
    let contractShipping;
    if(options.shipping) {
      contractShipping = Object.assign({},options.shipping);
      if(contractShipping['geo']) {
        contractShipping.lat = contractShipping.lat || contractShipping['geo'].lat;
        contractShipping.lng = contractShipping.lng || contractShipping['geo'].lng;
        delete contractShipping['geo'];  
      }
      const item = {
        id:'shipping',
        title:'shipping',
        price:contractShipping.price,
        quantity:1        
      }
      // check is subscription must be updated or created
      let product, stripe_id;
      if (contract){
        const stripeItem = contract.findOneItem('shipping');        
        product = stripeItem.price.product;
        stripe_id = stripeItem.id;
      }


      const itemShipping:any = await findOrCreateItemService(product,item,options.interval, isInvoice);
      (stripe_id) && (itemShipping.id = stripe_id);
      items.push(itemShipping);
    }

    return { items , servicePrice, contractShipping};
}

//
// Stripe need to attach a valid product for a subscription
async function findOrCreateProductFromItem(item) {
  const incache = cache.get(item.sku);
  if(incache) {
    return incache;
  }

  const product = await $stripe.products.search({
    query:"active:'true' AND name:'"+item.sku+"'", limit:1
  })
  if(product && product.data.length) {
    cache.set(item.sku,product.data[0].id);
    return product.data[0].id;
  }

  const created = await $stripe.products.create({
    name: item.sku,
    description:item.title + "(" + item.part + ")"
  });
  cache.set(item.sku,created.id);
  return created.id;
}

// 
// avoid reentrency
function lock(api){
  const islocked = locked.get(api)
  if (islocked){
    throw new Error("reentrancy detection");
  }
  locked.set(api,true);
}

function unlock(api) {
  locked.delete(api);
}


async function findOrCreateItemService(product,item, interval, isInvoice) {
  const { id,title,price, quantity } = item;

  // in case of update product is already known
  if(!product) {
    const products = await $stripe.products.search({
      query:"active:'true' AND name:'"+id+"'", limit:1
    })
    if(products && products.data.length) {
      product = products.data[0].id;
    } else {
      product = await $stripe.products.create({
        name: id,
        description:title
      });  
    }  
  }


  //
  // missing fees (see documentation for fees inclusion)
  // warning unit_amount is positive integer in cents 
  const recurring = (interval=='2weeks')? ({interval:'week',interval_count:2}):({interval,interval_count:1})
  const serviceItem:SubscriptionItem = { 
    currency : 'CHF', 
    unit_amount : isInvoice? 0:(price*100)|0,
    product : product,
    recurring
  };
  const metadata:SubscriptionMetaItem = {
    sku : id,
    type:"service",
    title,
    quantity,
    fees: (price.toFixed(2)),
  }

  return {metadata, quantity,price_data:serviceItem};
}

//
// only for week or month subscription
// day subscription is a special case
function createItemsFromCart(cartItems, interval, isInvoice) {
  const itemCreation = (item ) => {
    const price = round1cts(item.price * 100);

    //
    // missing fees (see documentation for fees inclusion)
    // warning unit_amount is positive integer in cents 
    const recurring = (interval=='2weeks')? ({interval:'week',interval_count:2}):({interval,interval_count:1})
    const instance:SubscriptionItem = { 
      currency : 'CHF', 
      unit_amount : (isInvoice ? 0:(price)),
      product : item.product,
      recurring
    };

    //console.log('--- DBG recurring',instance.recurring);
    const metadata:SubscriptionMetaItem ={
      sku : item.sku,
      type:"product",
      quantity: item.quantity,
      title : item.title,
      part : item.part,
      hub : item.hub,
      note : item.note,
      fees: (item.price).toFixed(2)
    }

    if(cartItems.variant){
      metadata.variant = cartItems.variant; 
    }

    //
    // avoid duplicate in case of update
    const resultItem:any = {metadata, quantity: item.quantity,price_data:instance};
    (item.id) && (resultItem.id = item.id);
    (item.deleted) && (resultItem.deleted = true);
    return resultItem;
  }

  //
  // prepare items for Stripe Schedule
  const items = cartItems.map(i => itemCreation(i));

  return items;
}


//
// parse subscription Item
function parseItem(item: Stripe.SubscriptionItem): SubscriptionProductItem {
  const result:SubscriptionProductItem = {
    id:item.id,
    unit_amount:item.price.unit_amount,
    currency:item.price.currency,
    quantity:(item.quantity),
    fees:parseFloat(item.metadata.fees),
    sku:item.metadata.sku,
    title:item.metadata.title,
    hub:item.metadata.hub,
    note:item.metadata.note||'',
    part:item.metadata.part
  };
  //
  // optional fields
  ["variant"].filter(key => item[key]).forEach(key=> result[key]=item[key]);
  return result;
}

//
// parse subscription Item
function parseServiceItem(item: Stripe.SubscriptionItem):SubscriptionServiceItem {
  const result:any = {
    unit_amount:item.price.unit_amount,
    currency:item.price.currency,
    quantity:(item.quantity),
    id:item.metadata.sku||item.metadata.title
  };
  if(item.metadata.title) {
    result.title = item.metadata.title;
  }
  if(item.metadata.fees) {
    result.fees = parseFloat(item.metadata.fees);
  }

  return result;
}


//
// parse scheduled shipping
function parseShipping(metadata) {
  try{
    const address = JSON.parse(metadata['address']) as SubscriptionAddress;
    return address;
  }catch(err){
    console.log('---- DBG error parseAddress',err);
    throw err;
  }
}

function parseError(err) {
  Config.option('debug') && console.log('---- DBG error',err);
  return new Error(err);
}
