/**
* #transaction.ts
* Copyright (c)2020, by olivier@karibou.ch
* Licensed under GPL license (see LICENSE)
* TODO? https://groups.google.com/a/lists.stripe.com/forum/#!topic/api-discuss/uoMz4saOa5I
*/

import { strict as assert } from 'assert';
import Stripe from 'stripe';
import Config from './config';
import { Customer } from './customer';
import { KngCard, $stripe, stripeParseError, unxor, xor, KngPayment, KngPaymentInvoice, KngPaymentStatus, KngOrderPayment, round1cts } from './payments';
import { LRUCache } from 'lru-cache';

const locked = new LRUCache({ttl:6000,max:1000});

export interface PaymentOptions {
  charge?:boolean;
  oid:string;
  txgroup:string;
  email:string;
  shipping: {
    streetAdress:string;
    postalCode:string;
    name: string;  
  }
}


export  class  Transaction {
  private _payment:Stripe.PaymentIntent|KngPaymentInvoice;
  private _refund:Stripe.Refund;

  // 
  // avoid reentrency
  private lock(api,root?){
    root = root||this._payment.id;
    const islocked = locked.get(root+api)
    if (islocked){
      throw new Error("reentrancy detection: "+root+api);
    }
    locked.set(root+api,true);
    Config.option('debug') && console.log('--- lock',root,api);
  }

  private unlock(api,root?) {
    root = root||this._payment.id;
    locked.set(root+api,false);
    locked.delete(root+api);
    Config.option('debug') &&  console.log('    unlock',root,api);
  }


  /**
   * ## transaction()
   * @constructor
   */
  private constructor(payment:Stripe.PaymentIntent|KngPaymentInvoice, refund?:Stripe.Refund) {    
    this._payment = payment;
    this._refund = refund || {} as Stripe.Refund;
  }

  get id():string{
    if(this._payment.id.indexOf('kng_')==0){
      return this._payment.id;
    }
    return xor(this._payment.id);
  }

  get oid():string{
    return (this._payment.metadata.order);
  }

  //
  // cash balance create a direct charge (automatic paiement)
  // subscription create a direct charge (automatic paiement)
  // WARNING to keep track of our needs of "manual" the status paid will be => auth_paid
  get status():KngPaymentStatus{
    //
    //
    // PaymentIntentStatus
    // https://stripe.com/docs/payments/intents#intent-statuses
    //   "canceled" "processing" "requires_action" "requires_capture" "requires_confirmation" 
    //   "requires_payment_method"| "succeeded";

    // KngPaymentExendedStatus 
    //  "refunded"|"prepaid"|"invoice"|"invoice_paid"|"pending"|"voided";

    // Karibou KngPaymentStatus
    //   "pending","authorized","partially_paid","paid","partially_refunded","refunded"
    //   "invoice","invoice_paid","voided"

    const status = {
      "processing":"pending",
      "succeeded":"paid",
      "canceled":"voided"
    }
    return (this._payment.metadata.exended_status || status[this._payment.status] ||this._payment.status) as KngPaymentStatus;
  }

  get client_secret():string{
    return (this._payment.client_secret);
  }

  get paymentId():string{
    return xor(this._payment.payment_method as string);
  }

  get customer():string{
    return (this._payment.customer as string);
  }


  //
  // return the total amount (authorized+balance) or the captured amount
  // total amount for a stripe transaction should complete with customer credit
  get amount():number{
    // balance amount is the amount paid with customer wallet
    const customer_credit = parseInt(this._payment.metadata.customer_credit||"0");
    const amount = (this.captured||this.canceled)? this._payment.amount_received||this._payment.amount:this._payment.amount;
    if(this.provider == 'invoice') {
      return round1cts((this._payment.amount)/100);
    }
    return round1cts((customer_credit + amount )/100);
  }

  get amount_received():number {
    return this._payment.amount_received || 0;
  }
  
  //
  // cutomer credit equals the amount for invoice payment
  // for mixed payment, credit is on metadata
  get customerCredit() {
    const credit = parseFloat(this._payment.metadata.customer_credit||'0')/100;
    return credit;
  }


  get group():string{
    return this._payment.transfer_group;
  }

  get currency():string{
    return this._payment.currency;
  }

  get description():string{
    return this._payment.description;
  }

  get provider(): string {
    return (this._payment.payment_method=="invoice")?"invoice":"stripe";
  }

  get requiresAction():boolean {
    return this.status == "requires_action" as KngPaymentStatus;
  }
  get authorized():boolean{
    return ["requires_capture","authorized","prepaid","invoice","invoice_paid"].includes(this.status);
  }
  get captured():boolean{
    return ["succeeded","paid","invoice","invoice_paid","refunded","partially_refunded","manually_refunded"].includes(this.status);
  }
  get canceled():boolean{
    return this.status == "voided" as KngPaymentStatus;
  }

  get refunded():number{
    const _refunded = parseInt(this._payment.metadata.refund || "0");
    return round1cts(_refunded/100);
  }

  get report(){
    const now = new Date();
    const amount = ["refunded","partially_refunded","manually_refunded"].includes(this.status)? this.refunded:this.amount;
    return {
      log: this.status + ' ' + (amount) + ' ' + this.currency + ' the '+ now.toDateString(),
      transaction:(this.id),
      status:this.status,
      amount: this.amount,
      refunded: this.refunded,
      customer_credit:this.customerCredit,
      updated:now.getTime(),
      provider:this.provider
    };
  }

  /**
  * ## transaction.authorize(...)
  * Create a new 2-steps transaction (auth & capture)
  * - https://stripe.com/docs/payments/customer-balance#make-cash-payment
  * @returns the transaction object
  */

  static async authorize(customer:Customer,card:KngCard, amount:number, options:PaymentOptions) {

    assert(options.oid)
    //
    // optional shipping
    if(options.shipping) {
      assert(options.shipping.streetAdress)
      assert(options.shipping.postalCode)
      assert(options.shipping.name)  
    }

    //
    // normalize amount
    amount = round1cts(amount);
    //
    // undefined or 0 amount throw an error
    if(!amount || amount < 1.0) {
      throw new Error("Minimum amount is 1.0");
    }
    
    //
    // available credit balance should be > 0
    const balanceAmount = (card.issuer=="invoice")? amount: Math.min(Math.max(customer.balance,0),amount);

    // is the providerAmount <= 1 THEN the transaction is canceled   
    // assert providerAmount > 100
		const providerAmount = round1cts((amount-balanceAmount));
		const tx_description = "oid:"+options.oid+" for "+customer.email;
    const tx_group = options.txgroup;


    //
    // IMPORTANT: 
    // https://stripe.com/docs/api/idempotent_requests
    // use idempotencyKey (oid) for safely retrying requests without accidentally 
    // performing the same payment twice.
    // ==> idempotencyKey: options.oid,

    try{
      const capture_method = (options.charge) ? "automatic":"manual";
      const params={
        amount:providerAmount*100,
        currency: "CHF",
        customer:unxor(customer.id),
        transfer_group: tx_group,
        off_session: false,
        capture_method: capture_method, // capture amount offline (server side)
        confirm: true,
        description: tx_description,
        metadata: {
          order: options.oid
        },
      } as Stripe.PaymentIntentCreateParams;

      //
      // optional shipping
      if(options.shipping) {
        params.shipping = {
          address: {
            line1:options.shipping.streetAdress,
            postal_code:options.shipping.postalCode,
            country:'CH'
          },
          name: options.shipping.name    
        }
      }
      Config.option('debug') && console.log('------- DBG  authorize: ask amount, providerAmount, balanceAmount',amount,providerAmount,balanceAmount);

      //
      // use customer credit instead of KngCard
      // use customer negative credit instead of KngCard
      // updateCredit manage the max negative credit
      if (card.issuer == 'invoice') {       
        // because balance amount and authorized amount use the same wallet 
        await customer.updateCredit(-amount,'authorize:'+options.oid);

        // as invoice transaction
        const transaction = createOrderPayment(customer.id,balanceAmount*100,0,balanceAmount*100,"authorized",options.oid);
        return new Transaction(transaction);
      }

      // FIXME cash balance on stripe wallet 
      // CASH BALANCE create a direct charge
      // manual paiement generate the status auth_paid
      // currency must be addressed
      else if (card.type == KngPayment.balance && customer.cashbalance.available) {
        params.payment_method_types = ['customer_balance'];
        params.payment_method_data= {
          type: 'customer_balance',
        };
        params.currency = customer.cashbalance.currency;
        params.capture_method='automatic';
        // 
        // option charge avoid the 2step payment simulation status  
        params.metadata.exended_status = options.charge ? 'paid':'prepaid';

      }
      else if (card.type == KngPayment.card) {
        params.payment_method = unxor(card.id);
        params.payment_method_types = ['card'];
      } else {
        throw new Error("Votre portefeuille ne dispose pas de fonds suffisants pour effectuer cet achat");
      }

      //
      // NOTE: stripe tx must be done before the customer.balance update
      const transaction = await $stripe.paymentIntents.create(params);
  
      //
      // update credit balance when coupled with card
      // should store in stripe tx the amount used from customer balance
      if(balanceAmount>0) {
        await customer.updateCredit(-balanceAmount,'authorize:'+options.oid);
        transaction.metadata.customer_credit = (balanceAmount*100+'');
        await $stripe.paymentIntents.update( transaction.id , { 
          metadata:transaction.metadata
        });  

      }

      return new Transaction(transaction);
  
    }catch(err) {
      throw parseError(err);
    }
  }



  /**
  * ## transaction.get(id)
  * Get transaction object from order api
  * @returns {Transaction} 
  */
   static async get(id) {
    const tid = unxor(id);
    const transaction = await $stripe.paymentIntents.retrieve(tid);
    assert(transaction.customer)
    return new Transaction(transaction);
  }

  /**
  * ## transaction.fromOrder(order)
  * Get transaction object from stored karibou order 
  * @returns {Transaction} 
  */
   static async fromOrder(payment:KngOrderPayment) {
    try{
      if(!payment.transaction) throw new Error("Man WTF!");
      //
      // FIXME issuer should be an KngPaymentIssuer
      switch (payment.issuer) {
        case "american express":
        case "amex":          
        case "visa":
        case "mc":
        case "mastercard":
        return await Transaction.get(payment.transaction);
        case "cash":
        case "balance":
        case "invoice":
          const txsig = payment.transaction.split('kng_')[1];
          if(!txsig) {
            throw new Error("Unknown transaction signature");
          }
          const tx=unxor(txsig).split('::');
          const oid = tx[0];
          const amount = parseFloat(tx[1]);
          const refund = parseFloat(tx[2]);
          const customer_id = tx[3];
          const customer_credit = parseFloat(tx[4]||"0");
          const transaction:KngPaymentInvoice = createOrderPayment(customer_id,amount,refund,customer_credit,payment.status,oid);

        return new Transaction(transaction);    
      } 
    }catch(err){
      Config.option('debug') && console.log('--- DBG',err.message);
    }

    throw new Error("La référence de paiement n'est pas compatible avec le service de paiement");
  }


  /**
  * ## transaction.confirm(paymentIntentId) 3d secure authorization
  * Capture the amount on an authorized transaction
  * @returns {any} Promise which return the charge object or a rejected Promise
  */
   static async confirm(paymentIntent:string) {
    const tid = (paymentIntent);
    const transaction = await $stripe.paymentIntents.update(tid);
    assert(transaction.customer)
    return new Transaction(transaction);
   }

  //
  // update status when transaction (capture_method) is automatic
  // prepaid is an eq of paid  
  async updateStatusPrepaidFor(oid) {    
    const metadata = this._payment.metadata;
    metadata.exended_status = 'prepaid';
    metadata.order = oid;
    this._payment = await $stripe.paymentIntents.update(this._payment.id, {metadata});  
  }

  /**
  * ## transaction.capture()
  * Capture the amount on an authorized transaction
  * @returns {any} Promise which return the charge object or a rejected Promise
  */
  async capture(amount:number) {
    if (amount == undefined || amount < 0){
      throw (new Error("Transaction need a null or positive amount to proceed"));
    }

    

    // Effectuer un re-capture lorsque la tx en cours a été annulée:
    // - durée de vie de 7 jours maximum,
    // - le montant à disposition est insuffisant
    // off_session = true  payment without user interaction
    // - https://stripe.com/docs/payments/save-during-payment#web-create-payment-intent-off-session
    const _force_recapture= (amount) => {

      // Pour donner un exemple, si un client a effectué plus de 5 paiements, 
      // ou une série de paiements d'une somme supérieure à 100€ 
      // sans authentification, la banque serait alors forcée de demander 
      // l'authentification sur le prochain paiement, même s'il est hors-session.

      const payment = this._payment as Stripe.PaymentIntent;
      const shipping = {
        address: {
          line1:payment.shipping.address.line1,
          postal_code:payment.shipping.address.postal_code,
          country:'CH'
        },
        name: payment.shipping.name
      };
  

      // FIXME, CHF currency are not accepted for US cards.!! 
      return $stripe.paymentIntents.create({
        amount:Math.round(amount*100),
        currency: "CHF",
        customer:(payment.customer as string),
        payment_method: (payment.payment_method as string), 
        payment_method_types : ['card'],
        transfer_group: this.group,
        off_session: true,
        capture_method:'automatic', 
        confirm:true,
        shipping: shipping,
        description: payment.description,
        metadata: payment.metadata
      });    
    }

    //
    // normalize amount, minimal capture is 1.0
    // remove already paid amount from customer.balance
    // this is the case of a mixed VISA + cash balance
    const balanceAuthAmount = parseInt(this._payment.metadata.customer_credit||"0") / 100;

    // total auth amount
    const providerAuthAmount = round1cts(this.amount-balanceAuthAmount);


    // if the amount is smaller than balanceAuthAmount, the capture is 0, the payment should be refunded
		const refundTotalAmount = round1cts(Math.max(0,this.amount-amount));

		//const refundAuthAmount = round1cts(Math.max(0,authAmount-refundTotalAmount));
		const refundBalanceAmount = (refundTotalAmount>=providerAuthAmount)?round1cts(refundTotalAmount-providerAuthAmount):0;
		const captureBalanceAmount = round1cts(Math.max(0,amount-providerAuthAmount));
    // capture for stripe
		const captureProviderAmount = round1cts(Math.max(0,amount-balanceAuthAmount));

    // new amount for customer_credit after capture
    const customerCreditCaptureAmount = Math.max(0,round1cts(balanceAuthAmount-refundBalanceAmount));

    const errorMsg = "The requested capture amount is greater than the amount you can capture for this charge.";
    Config.option('debug') && console.log('------- DBG capture ask amount, balanceAuthAmount, providerAuthAmount, refundBalanceAmount,captureProviderAmount, refundTotal',amount,balanceAuthAmount,providerAuthAmount, refundBalanceAmount,captureProviderAmount,refundTotalAmount);

    if(amount > this.amount) {
      throw new Error(errorMsg+' (1)');
    }

    //
    //  tx id ca change !
    const _method_root = this._payment.id;
    const _method = 'capture';
    try{
      this.lock(_method,_method_root);
  
      //
      // case of invoice or invoice_paid final validation (use this.amount at this stage)
      if(['invoice_paid','invoice'].includes(this.status)){

        //
        // in this case the amount should equal the preivous captured amount
        // FIXME github issue #117 (this.amount<(captureAmount/100))
        // console.log('----- DB capture',this.amount,'norm',captureAmount/100);
        // FIXME ❌ captureAmount equal 1 if amount < balanceAuthAmount
        if((this.amount)!= amount) {
          throw new Error("The payment could not be finalyzed because the paid amount is not equal to the value captured");
        }

        // captureAmount remove the amount paid from customer credit
        const status = "paid";
        //
        // depending the balance position on credit or debit, invoice will be sent
        this._payment = createOrderPayment(this.customer,this.amount*100,this.refunded*100,balanceAuthAmount*100,status,this.oid);
        return this;
      }

      //
      // case of customer credit
      if(this.provider=='invoice') {

        if (this.canceled){
          throw (new Error("Transaction canceled."));
        }
        if (!this.authorized){
          throw (new Error("Transaction need to be authorized."));
        }
    
        const customer = await Customer.get(this.customer);
        // use credit (invoice) OR debit (paid)
        let status=(customer.balance<0)? "invoice":"paid";

        // //
        // // case of authorized paiement
        // // capture can't exceed the initial locked amount 
        // if((this.amount)<=(round1cts(balanceAuthAmount + captureAmount))) {
        //   throw new Error(errorMsg+' (3)');
        // }

        //
        // compute the amount that should be restored on customer account
        // FIXME missing test with error when auth 46.3, capture 40 and refund 6.3
        //balanceAmount = (customerCreditCaptureAmount>0)?round1cts(refundBalanceAmount-captureAmount/100):captureAmount/100;// round1cts(this.amount*100-captureAmount)/100;          
        console.log('------- DBG captureBalanceAmount,refundBalanceAmount,customerCreditCaptureAmount',captureBalanceAmount,(refundBalanceAmount),customerCreditCaptureAmount,status);

        // the amount is adjusted with the balance (balanceAuthAmount)
        await customer.updateCredit(refundBalanceAmount,'capture:'+this.oid);

        //
        // depending the balance position on credit or debit, invoice will be sent
        this._payment = createOrderPayment(this.customer,captureBalanceAmount*100,0,customerCreditCaptureAmount*100,status,this.oid);
        return this;
      }

      //
      // CASH BALANCE or PREPAID when subscription
      if(this.status == "prepaid" as KngPaymentStatus) {
        const refundAmount = (this.amount-captureProviderAmount);
        // FIXME 1cts round issue between initial amount and capture amount
        if(refundAmount < -0.01) {
          throw new Error(errorMsg);
        }
        if(refundAmount < 0.02) {
          this._payment.metadata.exended_status = null;
          this._payment = await $stripe.paymentIntents.update( this._payment.id , { 
            metadata:this._payment.metadata
          });  
        } 
        //
        // for cashbalance total amount is not the same 
        // captureAmount remove the amount paid from customer credit
        // FIXME missing  for capture last_amount ==   refund(initial_amount - last_amount)
        // 
        else {
          await this.refund(refundAmount);  
        }
      } 
      //
      // case of KngCard
      // captureAmount remove the amount paid from customer credit
      else {
        // if(card.type == KngPayment.card)
        //
        // if amount is 0 (including shipping), cancel and mark it as paid
        // ONLY available for payment intents
        //
        // Perform an incremental authorization when captureAmount is greater than 
        // the currently authorized amount.
        // https://stripe.com/docs/terminal/features/incremental-authorizations
        // else if ((captureAmount)> payment.authorizeAmount) {
        //   await $stripe.paymentIntents.incrementAuthorization(
        //     this._payment.id,
        //     {amount: captureAmount}
        //   );
        // } 
        const metadata:Stripe.Metadata = this._payment.metadata;
        metadata.customer_credit = (customerCreditCaptureAmount*100+'');
        metadata.refund = '0';
        metadata.order = this.oid;
        const captureOpts = { 
          amount_to_capture:100,
          metadata
        } as Stripe.PaymentIntentCaptureParams;
        if(amount>1) {
          captureOpts.amount_to_capture = (captureProviderAmount*100);
        }
        this._payment = await $stripe.paymentIntents.capture( this._payment.id , captureOpts);  

      }
      return this;
    }catch(err) {

      const payment = this._payment as Stripe.PaymentIntent;
			const msg = err.message || err;
			//
			// cancel PaymentIntent can generate an error, avoid it (for now!)
			if(msg.indexOf('Only a PaymentIntent with one of the following statuses may be canceled')>-1){
				const result={
					log:'cancel '+this.oid+' , from '+new Date(payment.created),
					transaction:xor(payment.id),
					updated:Date.now(),
					provider:'stripe'
				};
				return result;
			}

      //
      // FORCE RECAPTURE when paymentIntent has expired
			// FIXME replace recapture when 'the charge has expired' but with payment_intents
			// case of recapture
			// 1. https://stripe.com/docs/api/payment_intents/cancel cancellation_reason == abandoned
			// 2. https://stripe.com/docs/error-codes#payment-intent-payment-attempt-expired
			// 3. https://stripe.com/docs/error-codes#charge-expired-for-capture
			if(msg.indexOf('PaymentIntent could not be captured because it has a status of canceled') == -1 &&
				msg.indexOf(' the charge has expired') == -1 ){
				throw (err);
			}

			this._payment = await _force_recapture(amount);
      return this;
    }finally{
      this.unlock(_method,_method_root);
    }

  }

  /**
  * ## transaction.cancel()
  * Cancel a transaction which has not been captured and prevent any future action
  */
  async cancel() {
    if (this.captured){
      throw new Error("Impossible to cancel captured transaction, try to refund.");
    }

    try{
      if(this.status == "prepaid" as KngPaymentStatus) {
        return await this.refund();
      }

      // keep stripe id in scope
      const stripe_id = this._payment.id;

      // 
      // invoice 
      if(this.provider == "invoice"){
        const customer = await Customer.get(this.customer);
        await customer.updateCredit(this.amount,'cancel:'+this.oid);                
        this._payment = createOrderPayment(this.customer,this.amount*100,this.refunded*100,"voided",this.oid, this._payment.metadata);
        // metadata are not saved ?
      }
      else if(this.provider == "stripe"){
        // Case of mixed amount
        // credit amount already paid with this transaction      
        const balanceAuthAmount = parseInt(this._payment.metadata.customer_credit||"0") / 100;
        if(balanceAuthAmount>0) {
          const customer = await Customer.get(this.customer);
          await customer.updateCredit(balanceAuthAmount,'cancel:'+this.oid);                
        }
        
        const metadata = this._payment.metadata;
        metadata.customer_credit = '0';
        this._payment = await $stripe.paymentIntents.cancel(stripe_id);
      }
      return this;  
    }catch(err) {
      throw parseError(err);
    }
  }

  /**
  * ## transaction.refund(amount?)
  * Refund a part or the totality of the transaction
  * @param {number} amount Value to refund frome the transaction,
  * if not given the totality of the transaction is refuned
  * @returns return the refund object report
  */
  async refund(amount?:number) {

    //
    // undefined amount implies maximum refund
    if(amount!=undefined && amount == 0) {
      throw new Error('Aucun montant a rembourser');
    }


    if (this.canceled){
      throw new Error("Transaction canceled.");
    }

    //
    // prepaid transaction is a simulation for 2 step payment
    // Therefore the case of the partial capture implies a refund
    if (!this.captured && this.status!="prepaid" as KngPaymentStatus){
      throw new Error("Transaction cannot be refunded before capture, try to cancel.");
    }


    // keep stripe id in scope
    const stripe_id = this._payment.id;
    const _method = 'refund';
    try{
      this.lock(_method,stripe_id);

      //
      // credit amount already paid with this transaction
      const customer = await Customer.get(this.customer);


      // total captured amount
      const balanceCaptureAmount = parseInt(this._payment.metadata.customer_credit||"0") / 100;
      const providerCaptureAmount = round1cts(this.amount-balanceCaptureAmount);
  
  
      // refund amount
      const refundPreviousAmount = this.refunded;
      const refundTotalAmount = amount||(this.amount-refundPreviousAmount);

      //
      // check maximum available amount
      if(refundTotalAmount >(this.amount-refundPreviousAmount)) {
        throw new Error("The refund has exceeded the amount available for this transaction");
      }
  
        
  
      //const refundAuthAmount = round1cts(Math.max(0,authAmount-refundTotalAmount));
      const refundBalanceAmount = ((refundTotalAmount)>providerCaptureAmount && amount>0)?
            round1cts(refundPreviousAmount+refundTotalAmount-providerCaptureAmount):(refundPreviousAmount)?(refundTotalAmount):0;
      // capture for stripe
      const refundProviderAmount = round1cts(Math.max(0,refundTotalAmount-refundBalanceAmount));
  
      Config.option('debug') && console.log('------- DBG refund: refundTotalAmount-- refundProviderAmount,refundPreviousAmount,refundBalanceAmount',refundTotalAmount,'--',refundProviderAmount,refundPreviousAmount,refundBalanceAmount,'--',this.amount);

      //
      // case of invoice mean all the transaction is based on customer credit
      // undefined amount implies total available amount
      await customer.updateCredit(refundBalanceAmount,'refund:'+this.oid);  
      if(this.provider=='invoice'){
        this._payment = createOrderPayment(this.customer,(this.amount)*100,round1cts(refundPreviousAmount+refundBalanceAmount)*100,(balanceCaptureAmount)*100,"refunded",this.oid);
        return this;
      }

      //
      // when balance and stripe are refunded 
      if(refundProviderAmount>0){
        this._refund = await $stripe.refunds.create({
          payment_intent: stripe_id, 
          amount:refundProviderAmount*100
        });  
      }
      //
      // update balance state
      this._payment.metadata.refund = round1cts(refundBalanceAmount+refundProviderAmount+refundPreviousAmount)*100+'';
      this._payment.metadata.exended_status = "refunded";
      this._payment = await $stripe.paymentIntents.update(stripe_id,{
        metadata:this._payment.metadata
      })  

  
      return this;
  
    }catch(err) {
      throw parseError(err);
    }finally{
      this.unlock(_method,stripe_id);
    }
  }

}

function createOrderPayment(customer_id,amount,refund,credit,status,oid, metadata?) {
  //
  // transaction id string format: order_id::amount::customer_id
  const customer_credit = (credit);
  metadata = Object.assign(metadata||{},{order:oid,refund:refund, customer_credit});
  //console.log('---createOrderPayment',oid+'::'+(amount)+'::'+(refund||0)+'::'+customer_id+'::'+(customer_credit||0))
  const transaction:KngPaymentInvoice = {
    amount:amount,
    client_secret:xor(oid),
    amount_refunded:refund||0,
    currency:'CHF',
    customer:customer_id,
    description:"#"+oid,
    metadata,
    id:'kng_'+xor(oid+'::'+(amount)+'::'+(refund||0)+'::'+customer_id+'::'+(customer_credit||0)),
    payment_method:'invoice',
    status:status,
    transfer_group:"#"+oid
 }
 return transaction;
}

function parseError(err) {
  const error = stripeParseError(err);
  Config.option('debug') && console.log('---- DBG error',error);
  return error;
}
