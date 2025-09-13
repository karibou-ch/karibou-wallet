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

export interface CartItem {
  sku:string;
  frequency?:SchedulerItemFrequency;
  quantity:number;  
  price:number;
  finalprice:number;
  hub:string;
  note?:string;
  [key: string]: any; // Allow other dynamic properties
}

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
  unpaid="unpaid", 
  incomplete="incomplete", 
  trialing="trialing",
  cancel="cancel"
}



export type SchedulerItemFrequency = 0|"day"|"week"|"2weeks"|"month"|string;


export interface SubscriptionAddress extends KngPaymentAddress {
}
  
//
// subscription is available for product with shipping, and for service only
export interface Subscription {
  id:string;
  plan:"service"|"customer"|"business"|"patreon"|string;
  customer: string;// as karibou id
  paymentMethod?: string; // as default payment method
  description: string;
  note:string;
  start:Date;
  nextInvoice:Date;
  pauseUntil: Date|0;
  frequency:SchedulerItemFrequency;
  status:string;
  acceptUnpaid?:number;
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
  shipping?: SubscriptionAddress
  // ❌ SUPPRIMÉ: useCustomerDefaultPaymentMethod (automatic_payment_methods always enabled)
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
  
  // https://docs.stripe.com/event-destinations#events-overview
  // this property indicates update in the subscription 
  public previous_attributes:any;


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
  /**
   * Calcule les informations de facturation et la prochaine date de facture
   * 
   * CAS DE FIGURES pour nextBilling :
   * 
   * 1. ABONNEMENT ACTIF (status: 'active')
   *    → nextBilling = current_period_end (prochaine facture normale)
   * 
   * 2. ABONNEMENT EN PAUSE avec limite (pause_collection.resumes_at défini)
   *    → nextBilling = MAX(current_period_end, resumes_at)
   *    → La facturation reprend à la date de reprise ou après
   * 
   * 3. ABONNEMENT EN PAUSE sans limite (pause_collection.resumes_at = null)
   *    → nextBilling = current_period_end (mais facturation suspendue)
   * 
   * 4. ABONNEMENT CANCELED/EXPIRED (status: 'canceled')
   *    → nextBilling = null (aucune facture future)
   * 
   * 5. ABONNEMENT INCOMPLETE/PAST_DUE
   *    → nextBilling = current_period_end (facture en attente de paiement)
   * 
   * @returns {Object} Informations de facturation avec nextBilling calculé
   */
  get interval () {
    const frequency = (this._interval === 'week' && this._interval_count === 2) ? '2weeks' : this._interval;

    // CAS 4: Abonnement canceled/expired → Pas de facturation future
    if (this._subscription.status === 'canceled' || this._subscription.status === 'incomplete_expired') {
      return {
        frequency,
        start: this.billing_cycle_anchor,
        count: this._interval_count,
        dayOfWeek: +this._subscription.metadata.dayOfWeek,
        nextBilling: null
      };
    }

    // CAS 1,2,3,5: Calcul de la prochaine facturation basé sur current_period_end
    // La source la plus fiable pour la prochaine facture est `current_period_end`.
    // Stripe calcule cette date pour nous, en tenant compte de l'ancre de facturation, des périodes d'essai, etc.
    let nextBilling = new Date(this._subscription.current_period_end * 1000);

    // CAS 2: Si l'abonnement est en pause avec une limite, la prochaine facturation aura lieu à la date de reprise ou après.
    const pauseResumeTimestamp = this._subscription.pause_collection?.resumes_at;
    if (pauseResumeTimestamp) {
      const resumeDate = new Date(pauseResumeTimestamp * 1000);
      // Si la prochaine date de facturation calculée est avant la date de reprise,
      // alors la vraie prochaine facturation est la date de reprise.
      if (nextBilling < resumeDate) {
        nextBilling = resumeDate;
      }
    }

    return {
      frequency,
      start: this.billing_cycle_anchor,
      count: this._interval_count,
      dayOfWeek: +this._subscription.metadata.dayOfWeek,
      nextBilling
    };
  }
  
  get environnement() {
    return this._subscription.metadata.env||'';
  }

  /**
   * Retourne les informations du dernier PaymentIntent de l'abonnement
   * 
   * PROBLÈMES POTENTIELS DE CHARGEMENT :
   * 1. SubscriptionContract.list() ne charge pas latest_invoice (pas d'expand)
   * 2. SubscriptionContract.listAllPatreon() ne charge pas latest_invoice 
   * 3. Constructeur peut recevoir subscription sans latest_invoice expandé
   * 
   * CAS DE FIGURES :
   * - latest_invoice non chargé → return null
   * - latest_invoice sans payment_intent → return null
   * - latest_invoice avec payment_intent valide → return objet complet
   * 
   * @returns {Object|null} PaymentIntent info ou null si non disponible
   */
  get latestPaymentIntent() {
    // CAS 1: latest_invoice non chargé (list/search sans expand)
    if (!this._subscription.latest_invoice) {
      // console.warn(`SubscriptionContract.latestPaymentIntent: latest_invoice non chargé pour subscription ${this._subscription.id}`);
      return null;
    }

    // CAS 2: latest_invoice est juste un ID string au lieu d'un objet
    // FIXME this should throw an error
    if (typeof this._subscription.latest_invoice === 'string') {
      console.warn(`SubscriptionContract.latestPaymentIntent: latest_invoice est un ID (${this._subscription.latest_invoice}), pas un objet expandé`);
      return null;
    }

    const invoice = this._subscription.latest_invoice as Stripe.Invoice;
    
    // CAS 3: latest_invoice sans payment_intent
    if (!invoice.payment_intent) {
      // Normal pour certains types d'abonnements (trial, future avec SetupIntent, etc.)
      return null;
    }

    // CAS 4: payment_intent est un ID string au lieu d'un objet
    if (typeof invoice.payment_intent === 'string') {
      console.warn(`SubscriptionContract.latestPaymentIntent: payment_intent est un ID (${invoice.payment_intent}), pas un objet expandé`);
      return null;
    }

    // CAS 5: payment_intent correctement expandé
    const paymentIntent = invoice.payment_intent as Stripe.PaymentIntent;
    return {
      source: paymentIntent.payment_method, 
      status: paymentIntent.status,
      id: paymentIntent.id,
      client_secret: paymentIntent.client_secret
    };
  }

  /**
   * Retourne le statut de l'abonnement avec normalisation pour l'interface utilisateur
   * 
   * SCÉNARIOS ET LOGIQUE DE STATUS :
   * 
   * 1. ABONNEMENT EN PAUSE (pause_collection défini)
   *    → Retourne 'paused' (priorité sur le status Stripe)
   *    → Facturation suspendue manuellement par l'utilisateur ou l'admin
   * 
   * 2. ABONNEMENT ACTIF (status: 'active')
   *    → Retourne 'active' 
   *    → Paiements fonctionnels, facturation régulière
   * 
   * 3. ABONNEMENT EN PÉRIODE D'ESSAI (status: 'trialing')
   *    → Retourne 'trialing'
   *    → Pas de facturation pendant la période d'essai
   * 
   * 4. ABONNEMENT ANNULÉ (status: 'canceled')
   *    → Retourne 'canceled'
   *    → Aucune facture future, accès arrêté
   * 
   * 5. PROBLÈMES DE PAIEMENT (status: 'incomplete', 'unpaid', 'past_due', 'incomplete_expired')
   *    → Retourne 'incomplete' (normalisation)
   *    → Nécessite intervention utilisateur pour méthode de paiement
   *    → Voir metadata.acceptUnpaid pour gestion des factures impayées
   * 
   * @returns {string} Status normalisé pour l'interface utilisateur
   * @see https://stripe.com/docs/api/subscriptions/object#subscription_object-status
   */
  get status () { 
    // SCÉNARIO 1: Pause manuelle prioritaire sur status Stripe
    if(this._subscription.pause_collection) {
      return 'paused';
    }
    
    // SCÉNARIOS 2,3,4,5: Normalisation des status Stripe
    // Status possibles: canceled, paused, incomplete, incomplete_expired, trialing, active, past_due, unpaid
    const stripeStatus = this._subscription.status.toString();
    switch(stripeStatus){
      // SCÉNARIO 5: Tous les problèmes de paiement → 'incomplete' normalisé
      case "incomplete":      // Paiement initial échoué ou en attente
      case "unpaid":          // Factures impayées après retry
      case "incomplete_expired": // Paiement initial expiré sans succès  
      case "past_due":        // Facture en retard de paiement
        return "incomplete";
      
      // SCÉNARIOS 2,3,4: Conservation du status Stripe original
      default:
        return stripeStatus; // 'active', 'trialing', 'canceled'
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
      note: this._subscription.metadata.note||'',
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
      acceptUnpaid:this.acceptUnpaid,
      description,
      paymentMethod: this.paymentMethod
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
    

    //
    // A null return value indicates that the subscription will use 
    // the customer's default payment method at the time of invoice creation.
    return null;
  }

  get paymentCredit() {
    return this._subscription.metadata.payment_credit;
  }

  /**
   * Retourne le nombre de factures impayées acceptées avant suspension
   * 
   * @returns {number|undefined} 
   *   - undefined : Comportement Stripe par défaut
   *   - 0 : Suspension immédiate si paiement échoue  
   *   - N > 0 : Accepte N factures impayées avant suspension
   */
  get acceptUnpaid() {
    const value = this._subscription.metadata.acceptUnpaid;
    return value ? parseInt(value.toString()) : undefined;
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

  //
  // find one item by sku (service, shipping, product,)
  // item.metadata.type = 'product' |'service' | 'shipping'
  // item.metadata.sku  = '1234' |'service'  | 'shipping' 
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

    // Stripe pause options and invoice workflow during pause:
    // 1. 'void': No invoices generated during pause. 
    //    Webhooks: No invoice events triggered.
    //    
    // 2. 'keep_as_draft': Invoices created as drafts (invoice.created) but not finalized or sent.
    //    Webhooks: invoice.created only, no payment attempts.
    //    
    // 3. 'mark_uncollectible': Invoices generated (invoice.created, invoice.finalized) but marked uncollectible. 
    //    Webhooks: invoice.created, invoice.finalized, invoice.marked_uncollectible.
    //    
    // Documentation: https://stripe.com/docs/billing/subscriptions/pause
    const behavior:any = {
      // Default behavior: void - no invoices generated during pause
      behavior: 'void'
    }
    
    // Set the resume date if provided
    // Important: resume time should be 2-3 days before the next shipping day
    if (to) {
      if(!to.toDateString) throw new Error("resume date is incorrect");
      // Convert JavaScript Date to Unix timestamp (seconds)
      behavior.resumes_at = parseInt(to.getTime()/1000+'');
    }
    
    // Note: We could also use 'from' parameter to schedule a future pause
    // Currently not implemented but could be added if needed
    // if (from && from.getTime()) {
    //   behavior.pauses_at = parseInt(from.getTime()/1000+'');
    // }

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
      this._subscription.id, {
        pause_collection: '', 
        metadata, 
        expand:['latest_invoice.payment_intent']
      }
    );

    cache.set(this._subscription.id,this);

  }


  //
  // validate required action (3ds)
  // 2. payment intent is confirmed and/or card is updated

  /*
   * FIXME: Automatiser la sélection du moyen de paiement via le client Stripe.
   *
   * Processus cible :
   * 1.  **Stocker les moyens de paiement sur le `Customer`** :
   *     - Au lieu d'associer un `default_payment_method` à l'objet `Subscription`, il faut l'associer au `Customer` via `invoice_settings.default_payment_method`.
   *     - L'utilisateur devrait pouvoir choisir sa carte "par défaut" pour l'ensemble de son compte.
   *
   * 2.  **Laisser la `Subscription` sans moyen de paiement par défaut** :
   *     - Lors de la création ou de la mise à jour d'un abonnement, le champ `default_payment_method` de la `Subscription` doit être `null`.
   *
   * 3.  **Profiter de la cascade de paiement Stripe** :
   *     - En procédant ainsi, Stripe tentera de payer la facture en utilisant d'abord le moyen de paiement par défaut du `Customer`.
   *     - En cas d'échec, Stripe essaiera automatiquement les autres moyens de paiement valides attachés au `Customer`, augmentant ainsi les chances de réussite du paiement.
   *
   * NOTE DE MIGRATION :
   * Il faudra créer un script pour mettre à jour tous les abonnements Stripe existants afin de retirer leur `default_payment_method` (le définir à `null`).
   * Cela les fera basculer sur la nouvelle logique de paiement basée sur le client.
   */
  async updatePaymentMethod(card:KngCard) {
    if (!card || !card.id) {
      throw new Error("Missing payment method");
    }

    // 1. First, try to settle any pending payment with the new card.
    const paymentIntent = this.latestPaymentIntent;
    if (paymentIntent && paymentIntent.status !== 'succeeded') {
      await $stripe.paymentIntents.confirm(paymentIntent.id, {
        payment_method: unxor(card.id)
      });
    }

    // 2. Mettre à jour le moyen de paiement par défaut du CLIENT.
    // C'est la seule source de vérité que nous voulons maintenant.
    await $stripe.customers.update(this._subscription.customer as string, {
      invoice_settings: {
        default_payment_method: unxor(card.id)
      }
    });

    // 3. Si la souscription avait encore un ancien moyen de paiement, le retirer.
    // C'est l'étape de migration, qui ne s'exécute que si nécessaire.
    if (this._subscription.default_payment_method) {
      await $stripe.subscriptions.update(this._subscription.id, {
        default_payment_method: null
      });
    }

    // 4. Final refetch to get the absolute latest state for the calling context.
    this._subscription = await $stripe.subscriptions.retrieve(this._subscription.id, {
      expand: ['latest_invoice.payment_intent']
    });

    cache.set(this._subscription.id, this);
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

  /**
   * Crée un SubscriptionContract à partir d'un webhook Stripe
   * 
   * NOTE: Les webhooks Stripe incluent généralement l'objet subscription complet,
   * mais latest_invoice.payment_intent pourrait ne pas être expandé selon le type d'événement.
   * 
   * @param {Stripe.Subscription} stripe - Objet subscription du webhook
   * @returns {SubscriptionContract} Instance du contrat
   */
  static fromWebhook(stripe) {
    return new SubscriptionContract(stripe); 
  }


  static async createOnlyFromService(customer:Customer, card:KngPaymentSource, interval:SchedulerItemFrequency,  product, subscriptionOptions: any = {}) {
    const isInvoice = card.issuer == "invoice";
    const quantity = 1;
    const price = product.default_price.unit_amount;

    const _method = 'createOnlyFromService'+customer.id;
    lock(_method);
    try{
      //
      // create metadata karibou model
      // https://github.com/karibou-ch/karibou-api/wiki/1.4-Paiement-par-souscription
      const metadata:any = { 
        uid:customer.uid, 
        plan:'patreon',
        // TODO: Gestion des factures impayées pour abonnements patreon
        // acceptUnpaid: undefined (pas de factures automatiques pour patreon)
        acceptUnpaid: undefined 
      };

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
      
      //
      // use custom title
      const title = product.metadata.title || product.name;

      const itemMetadata = {
        type:"patreon",
        title,
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
      // without billing_cycle_anchor l'abonnement sera facturé le dernier jour du mois.
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
      // payment method configuration
      if(card.issuer=="invoice") {
        // ✅ Invoice payment (fallback interne): Le paramètre 'card' est utilisé ici
        // ⚠️ ATTENTION: Ne passe pas par Stripe, paiement manuel
        metadata.payment_credit='invoice';
        options.payment_behavior = 'allow_incomplete';
        options.payment_settings = {}
      } else {
        // ✅ SOLUTION: Customer Default Payment Method Strategy (Stripe v11.18.0 compatible)
        // 🎯 IMPORTANT: Le paramètre 'card' est IGNORÉ ici - utilise customer.invoice_settings.default_payment_method
        // Note: customer.invoice_settings.default_payment_method is managed in customer.addMethod()
        // automatic_payment_methods n'est PAS supporté pour les subscriptions, même en v11.18.0+
        options.payment_behavior = 'default_incomplete';
        options.expand = ['latest_invoice.payment_intent'];
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
  /**
   * @param customer - Customer Stripe avec default_payment_method configuré
   * @param card - ⚠️ UNIQUEMENT pour paiements "invoice" (fallback interne). Pour les paiements Stripe normaux, utilise customer.invoice_settings.default_payment_method
   * @param interval - DEPRECATED: This will be moved into subscriptionOptions in a future version.
   * @param start_from - 'now' pour démarrage immédiat ou Date pour billing_cycle_anchor futur
   * @param cartItems - Items de l'abonnement
   * @param subscriptionOptions - Options de configuration (shipping, dayOfWeek, fees, plan)
   */
  static async create(customer:Customer, card:KngPaymentSource, interval:SchedulerItemFrequency, start_from,  cartItems:CartItem[], subscriptionOptions) {
    
    // check Date instance
    // timestamp: must be an integer Unix timestamp [getTime()/1000]
    assert(start_from=='now' || (start_from && start_from.getTime()));

    const {shipping, dayOfWeek, fees, plan} = subscriptionOptions;
    // ❌ SUPPRIMÉ: useCustomerDefaultPaymentMethod (automatic_payment_methods always enabled)
    assert(fees>=0)
    const _method = 'create'+customer.id;
    lock(_method);
    
    //
    // 1. Frequency validation logic
    //
    if (!interval) {
      // If no global interval is provided, ensure every item has its own frequency.
      if (!cartItems || cartItems.some(item => !item.frequency)) {
        throw new Error("Invalid subscription: A frequency must be provided either globally or for each item.");
      }
    }

    // ⚠️ Note: At this stage, we are only validating presence. The creation logic below
    // will still use a single interval. A future refactor will be needed to handle
    // multiple frequencies by creating multiple subscriptions.
    const effectiveInterval = interval || cartItems[0].frequency;


    try{

      if(card.type == 'twint') {
        throw new Error("Twint n'est pas supporté pour les souscriptions");
      }
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

      // TODO refactore to handle multiple frequencies
      cartItems = cartItems.filter(item => !!item.sku);

      if(!shipping && cartItems.length){
        throw new Error("Shipping address is mandatory with products");      
      }

      if (!cartServices.length && !cartItems.length) {
        throw new Error("Missing items");            
      }

      //
      // create stripe products
      // console.log('effectiveInterval',effectiveInterval);
      // console.log('cartItems',cartItems.map(item => ({frequency:item.frequency,price:item.price})));

      if(cartItems.some(item => (item.frequency!=effectiveInterval||!(item.price>=0)))){
        throw new Error("incorrect item format");
      }

      //
      // build items based on user cart
      const itemsOptions = {
        invoice:(card.issuer=='invoice'), 
        interval: effectiveInterval, 
        serviceFees:fees,
        shipping
      }

      const {items, contractShipping } = await createContractItemsForShipping(cartServices, cartItems, itemsOptions);

      //
      // be sure
      // assert(servicePrice>0);

      //
      // create metadata karibou model
      // https://github.com/karibou-ch/karibou-api/wiki/1.4-Paiement-par-souscription
      const metadataPlan = plan ||((cartItems.length)?'customer':'service');
      const metadata:any = { 
        uid:customer.uid, 
        fees,
        plan: metadataPlan,
        /**
         * TODO: Implémentation gestion factures impayées
         * 
         * acceptUnpaid: Nombre de factures impayées acceptées avant suspension
         * 
         * VALEURS POSSIBLES :
         * - undefined : Comportement Stripe par défaut (suspend après échec)
         * - 0 : Aucune facture impayée acceptée (suspension immédiate)
         * - N > 0 : Accepte N factures impayées avant suspension
         * 
         * LOGIQUE BUSINESS :
         * - Si acceptUnpaid > 0 : Stripe continue de créer des factures même si les précédentes sont impayées
         * - Les factures seront payées quand la méthode de paiement sera mise à jour
         * - Permet de maintenir l'accès au service temporairement
         * 
         * IMPLÉMENTATION FUTURE :
         * - Ajouter paramètre acceptUnpaid dans options de création d'abonnement
         * - Configurer payment_settings.payment_method_options selon acceptUnpaid
         * - Gérer la logique de suspension/réactivation automatique
         * - Webhooks pour notifier les factures impayées accumulées
         */
        acceptUnpaid: undefined  // Valeur par défaut : comportement Stripe standard
      };

      //
      // use clean shipping with price included
      if(contractShipping) {
        //
        // remove price from metadata as it's already in the contract.services[shipping].fees
        delete contractShipping.price;
        metadata.address = JSON.stringify(contractShipping,null,0);
        metadata.dayOfWeek = dayOfWeek
      }

      //
      // avoid webhook
      if(process.env.NODE_ENV=='test'){
        metadata.env="test";
      }


      const description = "contrat:" + effectiveInterval + ":"+ customer.uid;
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
        options.billing_cycle_anchor = (start_from.getTime()/1000)|0;
      }

      //
      // payment method configuration
      if(card.issuer=="invoice") {
        // ✅ Invoice payment (fallback interne): Le paramètre 'card' est utilisé ici
        // ⚠️ ATTENTION: Ne passe pas par Stripe, paiement manuel
        metadata.payment_credit='invoice';
        options.payment_behavior = 'allow_incomplete';
        options.payment_settings = {}
      } else {
        // ✅ SOLUTION: Customer Default Payment Method Strategy (Stripe v11.18.0 compatible)
        // 🎯 IMPORTANT: Le paramètre 'card' est IGNORÉ ici - utilise customer.invoice_settings.default_payment_method
        // Note: customer.invoice_settings.default_payment_method is managed in customer.addMethod()
        // automatic_payment_methods n'est PAS supporté pour les subscriptions, même en v11.18.0+
        options.payment_behavior = 'default_incomplete';
        options.expand = ['latest_invoice.payment_intent'];
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
  // Special product information (sku, fees, type="product", *deleted*)
  async update(upItems: CartItem[], subscriptionOptions) {
    const _method = 'updateContract'+upItems.length;
    lock(_method);

    let {shipping, dayOfWeek, fees} = subscriptionOptions;
    assert(fees>=0)
    
    try{
      
      // 1. update all the contract
      const shippingFeesFromContract = this.content.services.find(service => service.id =='shipping');
      shipping = shipping || this.shipping;
      dayOfWeek = dayOfWeek || this.content.dayOfWeek;
      shipping.price = shipping.price|| shippingFeesFromContract?.fees || 0;

      //
      // validate fees range [0..1]
      if((fees>1) || (fees <0)) {
        throw new Error("Incorrect fees params");
      }
      // in case of shipping
      // shipping price is mandatory to compute the total price
      if(shipping) {
        assert(dayOfWeek>=0);
      }

      //
      // filter items for services or products
      // DEPRECATED items always have a sku and cartServices equal []
      const cartServices = upItems.filter(item => !item.sku);
      let cartItems = upItems.filter(item => !!item.sku);

      //
      // check available items for update
      // FIXME: this should be done by createContractItemsForShipping
      if(!cartItems.length) {
        cartItems = this.content.items.map(item => {
          const cartItem = Object.assign({}, item, {frequency:this.interval.frequency,price:item.fees,finalprice:item.fees}) as unknown as CartItem;
          return cartItem;
        });
      }

      if(!shipping){
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
        shipping,
        updateContract:this
      }

      const {items, contractShipping } = await createContractItemsForShipping(cartServices, cartItems, itemsOptions);

      const metadata = this._subscription.metadata;

      (fees>=0) && (metadata.fees = fees);      
      (dayOfWeek>=0) && (metadata.dayOfWeek = dayOfWeek);

      //
      // use clean shipping
      if(contractShipping) {
        //
        // remove price from metadata as it's already in the contract.services[shipping].fees
        delete contractShipping.price;
        metadata.address = JSON.stringify(contractShipping,null,0);
      }

      //
      // remove previous service items
      // items.id => Subscription item to update
      // items.deleted => A flag that, if set to true, will delete the specified item.
      // const deleted = this._subscription.items.data.filter(item => item.metadata.type=='service').map(item=> ({id:item.id,deleted:true}));
      // proration_behavior = 'none', remove => La tarification au prorata 
      const options = {
        items:items,
        metadata,
        proration_behavior:'none',
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

      //
      // expand payment_intent if needed
      if(stripe.payment_intent && !stripe.payment_intent.id){
        stripe.payment_intent = await $stripe.paymentIntents.retrieve(stripe.payment_intent); 
      }
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
      status:'all',
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
    // ✅ CORRECTION: Ajouter expand pour latest_invoice.payment_intent
    const optionsWithExpand = {
      ...options,
      expand: ['data.latest_invoice.payment_intent']
    };
    const subscriptions:Stripe.ApiList<Stripe.Subscription> = await $stripe.subscriptions.list(optionsWithExpand);

    //
    // wrap stripe subscript to karibou 
    return subscriptions.data.map(sub => new SubscriptionContract(sub))

  }  

  static async listAllPatreon() {
    const query = {
      query: 'status:\'active\' AND metadata[\'plan\']:\'patreon\'',
      // ✅ CORRECTION: Ajouter expand pour charger latest_invoice.payment_intent
      expand: ['data.latest_invoice.payment_intent']
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
async function createContractItemsForShipping(cartServices, cartItems, options) {
  const contract = options.updateContract;// for update current contract with new items
  const isInvoice = options.invoice;

    //
    // check is subscription must be updated or created
    for(let item of cartItems) {
      if(item.product) {
        continue;
      }
      item.product = await findOrCreateProductFromItem(item);
    }
    //
    // group items by interval, day, week, month
    const stripeItems = createItemsFromCart(cartItems,options.interval,isInvoice);

    // 
    // compute service serviceFees
    // from input cartItems and contract.items (AND avoid multiple items with same SKU)
    // FIXME: merged items with live contract is made by contract.update(...)
    const servicePrice = cartItems.filter(item => !item.deleted).reduce((sum, item) => {
      return sum + (item.price * item.quantity * (options.serviceFees));
    }, 0);

    // 
    // FIXME: merged items with live contract is made by contract.update(...)
    // Compute service fees from existing contract.items
    // const contractItems = contract?.items.filter(item => !cartItems.some(cartItem => cartItem.sku==item.sku))||[];
    // const servicePrice = servicePriceFromCart + contractItems.reduce((sum, item) => {
    //   return sum + (item.price * item.quantity * (options.serviceFees));
    // }, 0);



    //
    // UPDATE the service item (to avoid multiple service items)
    // 'service' means fees X % for karibou.ch
    // FIXME: investigate how to use stripe to specify a product fees (X %)
    const stripeServiceItemToUpdate = contract?.findOneItem('service'); 
    const stripeShippingItemToUpdate = contract?.findOneItem('shipping');
    // console.log('⚠️  stripeServiceItemToUpdate',stripeServiceItemToUpdate?.id,stripeServiceItemToUpdate);
    // console.log('⚠️  stripeShippingItemToUpdate',stripeShippingItemToUpdate?.id,stripeShippingItemToUpdate?.metadata);

    //
    // create items for service fees and shipping
    // ⚠️ mean that some items are not service fees (shipping, patreon, etc.)
    if(servicePrice>0) {
      const item = {
        id:'service',
        title:'karibou.ch',
        price:round1cts(servicePrice),
        quantity:1        
      }
      const itemService:any = await findOrCreateItemService(stripeServiceItemToUpdate?.price.product,item,options.interval, isInvoice);
      (stripeServiceItemToUpdate) && (itemService.id = stripeServiceItemToUpdate.id);
      // add item to stripeItems
      stripeItems.push(itemService);  
    }
    //
    // DELETE service item when others items are NOT sku (as shipping, patreon, ...)
    else if(stripeServiceItemToUpdate){
      const itemService:any = {id:stripeServiceItemToUpdate.id,deleted:true};
      stripeItems.push(itemService);    
    }

    //
    // DEPRECATED
    // create items for service only
    // ⚠️ EXPLAIN THE PURPOSE OF THIS CODE ⤵
    // if(cartServices.length) {
    //   for(let elem of cartServices) {
    //     const item = {
    //       id:(elem.sku||elem.id),
    //       title:elem.title,
    //       price:elem.price,
    //       quantity:elem.quantity        
    //     }  

    //     // check is subscription must be updated or created
    //     const itemService:any = await findOrCreateItemService(stripeServiceItemToUpdate?.price.product,item,options.interval, isInvoice);
    //     (stripeServiceItemToUpdate) && (itemService.id = stripeServiceItemToUpdate.id);
    //     (elem.deleted) && (itemService.deleted = true);
    //     stripeItems.push(itemService);  
    //   }

    // }  

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


      const itemShipping:any = await findOrCreateItemService(stripeShippingItemToUpdate?.price.product,item,options.interval, isInvoice);
      (stripeShippingItemToUpdate) && (itemShipping.id = stripeShippingItemToUpdate.id);
      stripeItems.push(itemShipping);
    }

    return { items:stripeItems , servicePrice, contractShipping};
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
    fees: round1cts(price).toFixed(2),
  }

  return {metadata, quantity,price_data:serviceItem};
}

//
// only for week or month subscription
// day subscription is a special case
// TODO: must be refactored as createOrUpdateItemsFromCart(...) to handle subscription update
// TODO: must be refactored as to handle frequencies as item properties
function createItemsFromCart(cartItems:CartItem[], interval:SchedulerItemFrequency, isInvoice): Stripe.SubscriptionUpdateParams.Item[] {
  const itemCreation = (item: CartItem) => {
    const price = round1cts(item.price * 100);

    //
    // missing fees (see documentation for fees inclusion)
    // warning unit_amount is positive integer in cents 
    const recurring:any = (interval=='2weeks')? ({interval:'week',interval_count:2}):({interval,interval_count:1})
    const instance:SubscriptionItem|Stripe.PriceCreateParams|any = { 
      currency : 'CHF', 
      unit_amount : (isInvoice ? 0:(price)),
      product : item.product,
      recurring
    };

    //console.log('--- DBG recurring',instance.recurring);
    const metadata:SubscriptionMetaItem|Stripe.Emptyable<Stripe.MetadataParam>|any ={
      sku : item.sku,
      type:"product",
      quantity: item.quantity,
      title : item.title,
      part : item.part,
      hub : item.hub,
      note : item.note,
      fees: (item.price).toFixed(2)
    }

    // FIXME must be tested
    if(item.variant){
      metadata.variant = item.variant; 
    }

    //
    // avoid duplicate in case of update
    const resultItem:Stripe.SubscriptionUpdateParams.Item = {metadata, quantity: item.quantity,price_data:instance};
    //
    // case of delete or update
    if(item.id){
      resultItem.id = item.id;
    }
    if(item.id && item.deleted==true) {
      resultItem.deleted = true;
    }
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
