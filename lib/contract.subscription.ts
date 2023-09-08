import { strict as assert } from 'assert';
import Stripe from 'stripe';
import { Customer } from './customer';
import { $stripe, KngPaymentAddress, KngCard, unxor, xor, KngPaymentSource, round1cts } from './payments';
import Config from './config';


export type Interval = Stripe.Plan.Interval;

export interface SubscriptionProductItem{
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
  fees:Number,
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


export enum SchedulerItemFrequency {
  RECURRENT_NONE      = 0,
  RECURRENT_DAY       = "day",
  RECURRENT_WEEK      = "week",
  RECURRENT_2WEEKS    = "2weeks",
  RECURRENT_MONTH     = "month"
}

export interface SubscriptionAddress extends KngPaymentAddress {
  price?:number;
}
  
//
// subscription is available for product with shipping, and for service only
export interface Subscription {
  id:string;
  plan:"service"|"shipping";
  customer: string;
  description: string;
  start:Date;
  nextInvoice:Date;
  pauseUntil: Date|0;
  frequency:SchedulerItemFrequency;
  status:string;
  services: SubscriptionServiceItem[];
  latestPaymentIntent:any;
  issue?:string;
  dayOfWeek?:number;
  shipping?: SubscriptionAddress;
  items?: SubscriptionProductItem[];
};

export const subscriptionGetNextBillingMonth = (billing_cycle_anchor)=> {
  const now = new Date();
  if (now.getMonth() == 11) {
      return new Date(now.getFullYear() + 1, 0, billing_cycle_anchor.getDate());
  }

  return new Date(now.getFullYear(), now.getMonth() + 1, billing_cycle_anchor.getDate());
}

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
  }

  get id () { return xor(this._subscription.id) }
  get interval () { 
    return {
      start:this.billing_cycle_anchor,
      frequency: this._interval, 
      count:this._interval_count,
      dayOfWeek: +this._subscription.metadata.dayOfWeek
    } 
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
    const frequency = (this.interval.frequency.toString() as SchedulerItemFrequency)
    const today = new Date();
    //
    // verify 
    const invoice = (this._subscription.latest_invoice as Stripe.Invoice) || {payment_intent:{}};

    let nextBilling = new Date();//this._subscription.next_pending_invoice_item_invoice * 1000);


    //
    // week case next billing is always 3 days before the shipping
    // - Saturday for Tuesday (mar 2)
    // - Sunday for Wednesday (mer 3)
    // - Monday for Thusday (jeu 4)
    if(frequency == "week"){
      nextBilling.setDate(nextBilling.getDate() + 7);
    }

    //
    // month case next billing is always the same day
    if(frequency == "month"){
      nextBilling = subscriptionGetNextBillingMonth(this.interval.start)
    }

    // 
    // subscription can have the simplest form without product items
    const description = (this._subscription.description)? this._subscription.description.toString():"";
    const result:Subscription = {
      id: (this.id),
      customer: this._subscription.metadata.uid,
      start:this.interval.start,
      pauseUntil: this.pausedUntil,
      nextInvoice: nextBilling,
      frequency:(this.interval.frequency.toString() as SchedulerItemFrequency),
      status:this.status,
      issue:this._subscription.status.toString(),
      items:[],
      services: this.serviceItems,
      plan:"service",
      latestPaymentIntent: invoice.payment_intent,
      description
    }

    // 
    // subscription for product items with shipping
    if(this._subscription.metadata.address){
      result.dayOfWeek = (+this._subscription.metadata.dayOfWeek);
      result.shipping = this.shipping;
      result.plan = "shipping";
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
    // await $stripe.subscriptions.del(this._subscription.id)
    this._subscription = await $stripe.subscriptions.update(
      this._subscription.id,{cancel_at_period_end: true, expand:['latest_invoice.payment_intent']}
    );
  }

  //
  // update the contract with  karibou cart items
  // replaces the previous contract with the new items and price 
  // https://stripe.com/docs/billing/subscriptions/upgrade-downgrade
  async updateContract(cardTtems) {

  }

  //
  // set the subscription on pause, 
  // sub will pause on {from} Date ({from} billing must be aligned with the billing_cycle_anchor to avoid confusion)
  // sub will resume on {to} Date ({to} billing must be aligned 2-3 days before the dayOfWeek delivery) 
  // https://stripe.com/docs/billing/subscriptions/pause
  async pause(to:Date) {
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
      metadata.to = to.getTime()+'';
      behavior.resumes_at=parseInt(to.getTime()/1000+'');
    }

    metadata.from = Date.now()+'';

    this._subscription = await $stripe.subscriptions.update(
      this._subscription.id,
      {pause_collection: behavior, expand:['latest_invoice.payment_intent']}
    );
  }


  async resumeManualy(){
    const metadata = this._subscription.metadata;
    metadata.from = null;
    metadata.to = null;
    this._subscription = await $stripe.subscriptions.update(
      this._subscription.id, {pause_collection: '', metadata, expand:['latest_invoice.payment_intent']}
    );


  }


  //
  // validate required action (3ds)
  // 2. payment intent is confirmed and/or card is updated

  // 
  // Update current contract with the new customer payment method 
  async updatePaymentMethod(card:KngCard) {
    this._subscription = await $stripe.subscriptions.update(
      this._subscription.id, {
      default_payment_method: unxor(card.id),
      expand:['latest_invoice.payment_intent']
    });    
    return this;
  }



  //
  // create one subscription by recurring interval (mobth, day, week)
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
  static async create(customer:Customer, card:KngPaymentSource, interval:Interval, start_from,  cartItems, subscriptionOptions) {
    
    // check Date instance
    // timestamp: must be an integer Unix timestamp [getTime()/1000]
    assert(start_from && start_from.getTime());

    const {shipping, dayOfWeek, fees} = subscriptionOptions;
    assert(fees>=0)

    //
    // validate start_from when interval is month
    // FIXME avoid billing error we need to know any error 3 days before the shipping


    //
    // validate fees range [0..1]
    if((fees>1) || (fees <0)) {
      throw new Error("Incorrect fees params");
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
    if(cartItems.some(item => item.frequency!=interval)){
      throw new Error("incorrect item format");
    }
    const isInvoice = card.issuer == "invoice";

    // check is subscription must be updated or created
    for(let item of cartItems) {
      item.product = await findOrCreateProductFromItem(item);
    }
    // group items by interval, day, week, month
    const items = createItemsFromCart(cartItems,0,isInvoice);

    //
    // compute service fees
    const servicePrice = cartItems.reduce((sum, item) => {
      return sum + round1cts(item.price * item.quantity * (fees));
    }, 0)

    //
    // create an item for karibou.ch service fees and shipping
    if(cartItems.length&&servicePrice>=0) {
      const item = {
        id:'service',
        title:'karibou.ch',
        price:servicePrice,
        quantity:1        
      }
      const itemService = await findOrCreateItemService(item,interval, isInvoice)
      items.push(itemService);  
    }

    if(cartServices.length) {
      for(let elem of cartServices) {
        const item = {
          id:'service',
          title:elem.title,
          price:elem.price,
          quantity:elem.quantity        
        }  
        const itemService = await findOrCreateItemService(item,interval, isInvoice)
        items.push(itemService);  
      }

    }
    //
    // create metadata karibou model
    // https://github.com/karibou-ch/karibou-api/wiki/1.4-Paiement-par-souscription
    const metadata:any = { uid:customer.uid };

    if(shipping) {
      assert(shipping.price>=0);
      assert(dayOfWeek>=0);
      delete shipping['geo'];  
      const item = {
        id:'service',
        title:'shipping',
        price:shipping.price,
        quantity:1        
      }
      const itemShipping = await findOrCreateItemService(item,interval, isInvoice)
      items.push(itemShipping);
  
      //
      // clean shipping
      metadata.address = JSON.stringify(shipping,null,0);
      metadata.dayOfWeek = dayOfWeek
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


    const options = {
      customer: unxor(customer.id),
      payment_behavior:'allow_incomplete',
      off_session:false,
      description,
      billing_cycle_anchor: (start_from.getTime()/1000)|0, // 3 days before the 1st tuesday of the next week/month
      items:items,
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
      options.default_payment_method=unxor(card.id);
      options.expand = ['pending_setup_intent','latest_invoice.payment_intent']
    }

    try{
      //
      // https://stripe.com/docs/billing/testing
      const subscription = await $stripe.subscriptions.create(options);          
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
    }
  }

  /**
  * ## subscriptionContract.get()
  * @returns a Contract instance with all context data in memory
  */
   static async get(id) {
    // use the stripe id
    id = id.indexOf('sub_')>-1? id: unxor(id);
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

    // constraint subscription by date {created: {gt: Date.now()}}
    const subscriptions:Stripe.ApiList<Stripe.Subscription> = await $stripe.subscriptions.list({
      customer:unxor(customer.id) , expand:['data.latest_invoice.payment_intent']
    });

    //
    // wrap stripe subscript to karibou 
    return subscriptions.data.map(sub => new SubscriptionContract(sub))
  }

  //
  // active, unpaid, incomplete, paused
  static async listAll(options) {
    if(!options.active && !options.unpaid && !options.incomplete && !options.paused) {
      throw new Error("Subscription list params error");
    }
    // constraint subscription by date {created: {gt: Date.now()}}
    const subscriptions:Stripe.ApiList<Stripe.Subscription> = await $stripe.subscriptions.list(options);

    //
    // wrap stripe subscript to karibou 
    return subscriptions.data.map(sub => new SubscriptionContract(sub))

  }  
}

//
// Stripe need to attach a valid product for a subscription
async function findOrCreateProductFromItem(item) {
  const product = await $stripe.products.search({
    query:"active:'true' AND name:'"+item.sku+"'", limit:1
  })
  if(product && product.data.length) {
    return product.data[0].id;
  }

  const created = await $stripe.products.create({
    name: item.sku,
    description:item.title + "(" + item.part + ")"
  });
  return created.id;
}

async function findOrCreateItemService(item, interval, isInvoice) {
  const { id,title,price, quantity } = item;
  const products = await $stripe.products.search({
    query:"active:'true' AND name:'"+id+"'", limit:1
  })
  let product;
  if(products && products.data.length) {
    product = products.data[0].id;
  } else {
    product = await $stripe.products.create({
      name: id,
      description:title
    });  
  }


  //
  // missing fees (see documentation for fees inclusion)
  // warning unit_amount is positive integer in cents 
  const serviceItem:SubscriptionItem = { 
    currency : 'CHF', 
    unit_amount : isInvoice? 0:(price*100),
    product : product,
    recurring : { interval, interval_count: 1 }
  };
  const metadata:SubscriptionMetaItem = {
    sku : id,
    type:"service",
    title,
    quantity,
    fees: (isInvoice ? 0:price.toFixed(2)),
  }

  return {metadata, quantity,price_data:serviceItem};
}

//
// only for week or month subscription
// day subscription is a special case
function createItemsFromCart(cartItems, fees, isInvoice) {
  const itemCreation = (item ) => {

    const metadata:SubscriptionMetaItem ={
      sku : item.sku,
      type:"product",
      quantity: item.quantity,
      title : item.title,
      part : item.part,
      hub : item.hub,
      note : item.note,
      fees
    }

    if(cartItems.variant){
      metadata.variant = cartItems.variant; 
    }

    const price = round1cts(item.price * 100).toFixed(2);

    //
    // missing fees (see documentation for fees inclusion)
    // warning unit_amount is positive integer in cents 
    const instance:SubscriptionItem = { 
      currency : 'CHF', 
      unit_amount : (isInvoice ? 0:parseInt(price)),
      product : item.product,
      recurring : { 
        interval:item.frequency, 
        interval_count: 1 
      }
    };

    return {metadata, quantity: item.quantity,price_data:instance};
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
  const result = {
    unit_amount:item.price.unit_amount,
    currency:item.price.currency,
    quantity:(item.quantity),
    fees:parseFloat(item.metadata.fees),
    title:item.metadata.title,
    id:item.metadata.sku
  };
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
