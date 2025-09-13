import { strict as assert } from 'assert';
import Stripe from 'stripe';
import { $stripe, stripeParseError, crypto_randomToken, crypto_fingerprint, xor, unxor, 
         KngPayment, KngPaymentAddress, KngCard, CashBalance, CreditBalance, dateFromExpiry, parseYear, 
         normalizePhone} from './payments';
import Config, { nonEnumerableProperties } from './config';

//
// using memory cache limited to 1000 customer in same time for 24h
const cache = new (require("lru-cache").LRUCache)({ttl:1000 * 60 * 60 * 24,max:2000});
const locked = new (require("lru-cache").LRUCache)({ttl:3000,max:1000});

export class Customer {

  private _sources:Stripe.Card[]|any;
  private _id:string;
  private _metadata:any;
  private _cashbalance:any;
  private _balance: number;
  private _balance_is_recently_updated: boolean|undefined;
  private _default_payment_method:string;

  //
  // phone or email share the same role of identity
  private _email:string;
  private _phone:string;
  private _fname:string;
  private _lname:string;  

  //
  // mapped with backend
  private _uid:string;

  //
  // collected from metadata
  private _addresses:KngPaymentAddress[];

  // handle previous customer attributes from customer.update webhook event
  public previous_attributes: any;

  /**
   * ## customer(id,email,displayName,uid)
   * @param  customer created by Stripe
   * @constructor
   */
  private constructor(id:string,email:string, phone: string, default_payment_method:string, cashbalance:any, balance:number, metadata:any) {
    assert(id);
    assert(email);
    assert(metadata.uid);
    assert(metadata.fname);
    assert(metadata.lname);
    this._balance = balance;
    this._email = email;
    this._phone = phone ||'';
    this._fname = metadata.fname;
    this._lname = metadata.lname;
    this._uid = metadata.uid+'';
    this._id = (id+'');
    this._metadata = metadata;
    this._cashbalance = cashbalance||{};
    this._default_payment_method = default_payment_method;

    //
    // when loading existant customer
    this._sources = [];
    this._addresses = parseAddress(metadata);

    //
    // put this new customer in cache 4h
    cache.set(this._uid,this.id);
    cache.set(this.id,this);

    //
    // secure this content from serialization
    nonEnumerableProperties(this);
  }

  //
  // Stripe id must be stable over time, this why we dont use xor(_id)
  get id() {
    return xor(this._id);
  }

  get deleted() {
    return false;
  }
  
  get email() {
    return this._email;
  }

  //
  // balance can be coupled with Card or Cashbalance
  get balance() {
    return this._balance/100;
  }

  //
  // updated is true, false or undefined
  get balanceRecentlyModified() {
    return this._balance_is_recently_updated;
  }
  
  get phone() {
    return this._phone;
  }

  get name() {
    return {
      familyName:this._lname,
      givenName:this._fname
    };
  }

  get uid() {
    return this._uid;
  }

  get addresses() {
    return this._addresses.slice();
  }

  get methods() {
    return this._sources.slice();
  }

  /**
   * Retourne la méthode de paiement par défaut du customer
   * @returns {KngCard|null} La méthode de paiement par défaut ou null si aucune
   */
  get defaultMethod() {
    return this._sources.find(method => method.default) || null;
  }

  get cashbalance() {
    if(this._cashbalance.available){
      const available = Object.assign({},this._cashbalance.available);
      const balance = Object.assign({},this._cashbalance,{
        available
      });
  
      // 
      // FIXME using default currency [0] should be removed
      const currency = Object.keys(balance.available)[0];
      balance.available[currency] = balance.available[currency]/100
      balance['currency']=currency;
      return balance;
    }
    return { available:null };
  }

  // 
  // avoid reentrency
  lock(api,root?){
    root = root||this.id;
    const islocked = locked.get(root+api)
    if (islocked){
      throw new Error("reentrancy detection");
    }
    locked.set(root+api,true);
  }

  unlock(api,root?) {
    root = root||this.id;
    locked.delete(root+api);
  }

  //
  // search api
  // https://stripe.com/docs/search
  static async allWithActiveCreditbalance(){
    const customer = await $stripe.customers.search({
      query: "-metadata['creditbalance']:null",
    });
  }

  static async search(query){
    const customers = await $stripe.customers.search({
      query: `phone~'${query}' OR name~'${query}' OR email~'${query}'`
    });

    const defaultUser = Object.assign({},{
      phone:'0225550000',
      cash_balance:0,
      balance:0,
      metadata:{uid:'0',fname:'foo',lname:'bar'}
    });
    
    return customers.data.filter(stripe => !!stripe.email).map(stripe => {
      const merged = Object.assign({},defaultUser,stripe);
      merged.metadata = Object.assign({},defaultUser.metadata,stripe.metadata)
      return new Customer(
        merged.id,
        merged.email,
        merged.phone,
        stripe.invoice_settings.default_payment_method?.toString() || null,
        merged.cash_balance,
        merged.balance,
        merged.metadata
      )
    });
  }

  /**
  * ## customer.create()
  * Async constructor of customer
  * @returns a new Customer 
  */
  static async create(email:string, fname:string, lname:string, phone: string, uid:string) {
    try{

      assert(email);
      assert(uid);
      
      //Le prénom (First Name - fname)
      assert(fname);

      //Le nom de famille (Last Name - lname)
      assert(lname);
            
      const stripe = await $stripe.customers.create({
        description: fname + ' ' + lname + ' id:'+uid,
        email: email,
        name: fname + ' ' + lname,
        phone,
        metadata: {uid,fname, lname},
        expand: ['cash_balance']
      });  

      return new Customer(stripe.id,email,phone, stripe.invoice_settings?.default_payment_method?.toString() || null,stripe.cash_balance,0,stripe.metadata); 
    }catch(err) {
      throw parseError(err);
    } 


    // try{

    // }catch(err) {
    //   throw parseError(err);
    // } 
  }
      
  /**
  * ## customer.lookup() from customer in cache (should not be async)
  * @returns a Customer instance from LRU-cache
  */
   static lookup(uid) {
    // stringify
    uid=uid+'';

    //
    // lookup for karibou.ch as customer or pointer of customer
    const customer = cache.get(uid)||cache.get(xor(uid));
    if(customer && customer.id) {
      return customer;
    }

    //
    // lookup verify as pointer of stripe customer
    return cache.get(customer) as Customer;
   }


   static clearCache(id) {
    // use the stripe id
    id = id.indexOf('cus_')==-1? id: xor(id);
    cache.delete(id);
  }

  /**
  * ## customer.get()
  * @returns a Customer instance with all private data in memory
  */
  static async get(id) {
    if(typeof id == 'string') {
      const cached = Customer.lookup(id) as Customer;
      if(cached){
        return cached;
      }  
    }

    try{
      //
      // safe mock for basics testing
      const stripeMock = (Config.option('sandbox') && id.stripeMock);
      const stripe_id = (id.indexOf&&id.indexOf('cus_')>-1) ? id:unxor(id);
      const stripe = stripeMock || (await $stripe.customers.retrieve(stripe_id,{expand: ['cash_balance']})) as any;
      if(stripe.deleted) {
        throw new Error("Ce compte client a été définitivement supprimé")
      }
      const customer = new Customer(
        stripe.id,
        stripe.email,
        stripe.phone,
        stripe.invoice_settings?.default_payment_method,
        stripe.cash_balance,
        stripe.balance,
        stripe.metadata
      ); 
      if(!stripeMock){
        await customer.listMethods();
      }
      return customer;
    }catch(err) {
      throw parseError(err);
    } 
  }

  static async fromWebhook(stripe) {
    try{
      const customer = new Customer(
        stripe.id,
        stripe.email,
        stripe.phone,
        stripe.invoice_settings?.default_payment_method,
        stripe.cash_balance,
        stripe.balance,
        stripe.metadata
      ); 
      await customer.listMethods();
  
    }catch(err){
      throw parseError(err);
    }

  }

  async addressAdd(address: KngPaymentAddress) {
    assert(this._metadata.uid);
    assert(this._metadata.fname);
    assert(this._metadata.lname);
    const _method = 'addaddress';
    this.lock(_method);
    try{
      const keys = metadataElements(this._metadata,'addr');
      address.id = 'addr-' + keys.length + 1;
      this._metadata[address.id] = JSON.stringify(address,null,0);
      const customer = await $stripe.customers.update(
        this._id,
        {metadata: this._metadata, expand: ['cash_balance']}
      );
      
      this._metadata = customer.metadata;
      this._addresses = parseAddress(customer.metadata);  

      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
      return Object.assign({},address);
    }catch(err) {
      throw parseError(err);
    }finally{
      this.unlock(_method);
    }     
  }

  async addressRemove(address: KngPaymentAddress) {
    assert(this._metadata.uid);
    assert(this._metadata.fname);
    assert(this._metadata.lname);
    assert(this._metadata[address.id]);
    const _method = 'addressRemove';
    this.lock(_method);

    try{
      this._metadata[address.id] = null;
      const customer = await $stripe.customers.update(
        this._id,
        {metadata: this._metadata, expand: ['cash_balance']}
      );
      
      this._metadata = customer.metadata;
      this._addresses = parseAddress(customer.metadata); 
      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
      return this;
    }catch(err) {
      throw parseError(err);
    }finally{
      this.unlock(_method);
    }     
  }

  async addressUpdate(address: KngPaymentAddress) {
    assert(this._metadata.uid);
    assert(this._metadata.fname);
    assert(this._metadata.lname);
    assert(this._metadata[address.id]);
    const _method = 'addressUpdate';
    this.lock(_method);

    try{
      if(address.phone) {
        address.phone = normalizePhone(address.phone);
      }
      this._metadata[address.id] = JSON.stringify(address,null,0);
      const customer = await $stripe.customers.update(
        this._id,
        {metadata: this._metadata, expand: ['cash_balance']}
      );
      
      this._metadata = customer.metadata;
      this._addresses = parseAddress(customer.metadata);  
      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
      return this;
    }catch(err) {
      throw parseError(err);
    }finally{
      this.unlock(_method);
    }     
  }  

  /**
  * ## customer.addMethodIntent()
  * Intent to add a new method of payment (off_session) to the customer
  * @returns the payment Intent object
  */
  async addMethodIntent() {
    return await $stripe.setupIntents.create({
      usage:'off_session',
    });
  }


  /**
  * ## customer.addMethod()
  * attach method of payment to the customer
  * - https://stripe.com/en-gb-ch/guides/payment-methods-guide
  * - https://stripe.com/docs/payments/wallets
  * - https://stripe.com/docs/connect/crypto-payouts
  * - https://stripe.com/docs/billing/customer/balance
  * @returns the payment method object
  */
  async addMethod(token:string, options?:any) {
    const _method = 'addmethod'
    this.lock(_method);

    try{
      const method:any = await $stripe.paymentMethods.attach(token,{
        customer:this._id,
      });
      
      if (!method || method.customer !== this._id) {
        throw new Error('Échec d\'attachement de la méthode de paiement, contactez le support karibou.ch');
      }

      const card = parseMethod(method, true); // ✅ Cette méthode devient la default
      this._default_payment_method = method.id;

      //
      // Set this payment method as the default for all future invoices and payments
      // Use method.id instead of token to ensure we're using the attached payment method ID
      await $stripe.customers.update(method.customer, {
        invoice_settings: {
          default_payment_method: method.id
        }
      });

      //
      // replace payment method if old one already exist (update like)
      const exist = this._sources.findIndex(method => card.alias == method.alias )

      if(exist>-1) {
        //
        // FIXME cannot remove payment used by an active subscription
        await $stripe.paymentMethods.detach(unxor(this._sources[exist].id));
        this._sources[exist] = card;
      } else {
        this._sources.push(card);
      }

      //
      // put this new customer in cache 4h
      cache.set(this.id,this);

      return card;
    }catch(err) {
      throw parseError(err);
    } finally{
      this.unlock(_method);
    }
  }


  //
  // update customer balance with coupon code
  async applyCoupon(code:string) {
    const _method = 'appcoupon'+code;
    this.lock(_method,'');
    try{
      const coupon = await $stripe.coupons.retrieve(
        code
      );
  
  
      
      const amount = coupon.amount_off;
      const validity = new Date(coupon.created*1000 + (coupon.duration_in_months||12)*32*86400000);
      
      //
      // check if the coupon is still valid
      if (validity.getTime()<Date.now()){
        throw new Error("Le coupon n'est plus valide, merci de bien vouloir nous contacter");
      }
      //
      // check if the coupon is associated to this customer
      if(coupon.metadata.id && this.id != coupon.metadata.id) {
        throw new Error("Le coupon n'est pas associé à ce compte client");
      }
  
      if(!amount || amount<0) {
        throw new Error("le coupon ne contient pas de crédit");
      }
  
      const note = code+':'+coupon.name;
  
      //
      // it's more safe to remove code 
      await $stripe.coupons.del(code);
      await this.updateCredit(amount/100,note);
      return this;
    }catch(err) {
      throw err;
    }finally{
      this.unlock(_method,'');
    }
  }

  //
  // check if a payment method is valid
  // FIXME: missing test for checkMethods(addIntent:boolean)
  async checkMethods(addIntent:boolean, amount?:number) {

    // 
    // make sure that we get the latest
    const methods  = await this.listMethods();
    const result:any = {
      intent: false
    };

    //
    // only for 3d secure 
    if(addIntent) {
      result.intent = await this.addMethodIntent();
    }

    //
    // last day of the month
    const thisMonth = new Date();
    thisMonth.setDate(0);

    for (const method of methods){
      const id = unxor(method.id);
      const alias = unxor(method.alias);
      if(!id || !alias) {
        result[method.alias] = {error : "La méthode de paiement n'est pas compatible avec le service de paiement", code: 1};
        continue;
      }
      const card = this.findMethodByAlias(method.alias);
      if(!card){
        result[method.alias] = {error : "La méthode de paiement n'existe pas", code: 2};
        continue;
      }
      if(dateFromExpiry(card.expiry)<thisMonth) {
        result[method.alias] = {error : "La méthode de paiement a expirée", code: 3};
        continue;
      }
      if(card.issuer=='cash' && amount > this.balance ){
        result[method.alias] = {error : "Votre portefeuille ne dispose pas de fonds suffisants pour effectuer un achat", code: 3};
        continue;
      }


      result[method.alias] = {
        issuer:card.issuer,
        expiry:card.expiry
      };

    }  

    return result;
  }

  //
  // A customer’s credit balance represents internal funds that they can use for futur payment. 
  // If positive, the customer has an amount owed that will be added to their next invoice. 
  // If negative, the customer has credit to apply to their next payment. 
  // Only admin user can update the available credit value
  async allowCredit(allow:boolean, month?:string,year?:string) {
    const _method = 'allowCredit';
    this.lock(_method);
    try{
      const fingerprint = crypto_fingerprint(this.id+this.uid+'invoice');
      const id = crypto_randomToken();
      const mo = parseInt(month||'1');
      if(mo<1 || mo>12 ){
        throw new Error("Incorret month params")
      }
      
      let creditbalance:CreditBalance;
      if(allow) {
        year = parseYear((year||'2030')+'')
        creditbalance = {
          type:KngPayment.credit,
          id:xor(id),
          alias:(fingerprint),
          expiry:(month||'12') +'/'+ (year),
          funding:'credit',
          issuer:'invoice',
          limit:Config.option('allowMaxCredit')
        }
    
    
    
        //
        // expose Credit Balance to this customer
        this._metadata['creditbalance'] = JSON.stringify(creditbalance,null,0);
    
        //
        // this is the signature of an credit authorization
        this._sources.push(creditbalance);
  
  
      }else {
        this._metadata['allowCredit'] = null;
        this._metadata['creditbalance'] = null;
        const index:number= this._sources.findIndex(src => src.issuer == 'invoice');
        if(index>-1){
          this._sources.splice(index,1);
        }
      }
  
      const customer = await $stripe.customers.update(
        this._id,
        {metadata: this._metadata}
      );
  
      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
  
      //
      // return credit card when it exist
      return creditbalance;
    }catch(err) {
      throw err;
    }finally{
      this.unlock(_method);
    }
  }


  //
  // A customer’s cash balance represents funds that they can use for futur payment. 
  // By default customer dosen't have access to his cash balance
  // We can activate his cash balance and also authorize a amount of credit 
  // that represents liability between us and the customer.
  async createCashBalance(month:string,year:string):Promise<CashBalance>{
    const _method = 'createCashBalance';
    this.lock(_method);
    try{
      const cashbalance:CashBalance = createCashMethod(this.id,this.uid,month,year);

      //
      // expose Cash Balance to this customer
      this._metadata['cashbalance'] = JSON.stringify(cashbalance,null,0);
      const customer = await $stripe.customers.update(
        this._id,
        {metadata: this._metadata,expand:['cash_balance']}
      );
  
      this._cashbalance = customer.cash_balance ||{};
      this._metadata = customer.metadata;
      this._addresses = parseAddress(customer.metadata);  
  
      const index = this._sources.findIndex(card => card.alias == (cashbalance.alias));;
      if(index>-1){
        this._sources[index]=cashbalance;
      }else{
        this._sources.push(cashbalance);
      }
  
      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
  
      return cashbalance;      
    }catch(err){
      throw err;
    }finally{
      this.unlock(_method);
    }
  }

  async listBalanceTransactions(limit?:number) {
    limit = limit || 3;
    const ONE_HOUR = 3600000; /* ms */
    const balanceTransactions = await $stripe.customers.listBalanceTransactions(
      unxor(this.id),
      {limit}
    );
    // 
    // https://stripe.com/docs/api/customer_balance_transactions/create
    const txs = balanceTransactions.data.map(tx => {
      return {
        amount:tx.amount,
        description:tx.description,
        ending_balance: tx.ending_balance,
        created:new Date(tx.created*1000)
      }
    });
    this._balance_is_recently_updated = txs.some(tx =>  (Date.now() - ONE_HOUR)>tx.created.getTime())

    //
    // put this new customer in cache 4h
    cache.set(this.id,this);
    return txs;
  }
  
  /**
   * @deprecated dead function listBankTransfer
   * @returns 
   */
  async listBankTransfer(){
    //
    // the installed versions of stripe and @type/stripe doesn't support the 
    // API listCashBalanceTransactions, I have to add it
    (<any>$stripe.customers).listCashBalanceTransactions = Stripe.StripeResource.method({
      method: 'GET',
      path: '/{customer}/cash_balance_transactions',
      methodType: 'list',
    });
    const cashBalanceTransactions = await (<any>$stripe.customers).listCashBalanceTransactions(
      (this._id),
      {limit: 15}
    );    

    return cashBalanceTransactions.data;
  }

  /**
  * ## customer.listMethods()
  * List of all the payment's method of the customer
  * @returns {any[]} return the list of available methods
  */
  async listMethods() {
    try{
      // ✅ RÉCUPÉRER le customer Stripe pour obtenir default_payment_method
      const defaultPaymentMethodId = this._default_payment_method;
      
      this._sources = await $stripe.paymentMethods.list({
        customer:this._id,
        type:'card'
      });  
      this._sources = this._sources.data.map(method => 
        parseMethod(method, method.id === defaultPaymentMethodId)
      );

      //
      // credit customer
      const creditbalance = this._metadata['creditbalance'];

      //
      // cashbalance
      const cashbalance = this._metadata['cashbalance'];
      if(cashbalance) {
        const payment = JSON.parse(cashbalance) as CashBalance;
        this._sources.push(payment);        
      } 

      //
      // add cash method 
      else if(this.balance > 0 && !creditbalance) {
        const payment = createCashMethod(this.id,this.uid,"12","2030");
        this._sources.push(payment);        
      }

      if(creditbalance) {
        const payment = JSON.parse(creditbalance) as CreditBalance;
        payment.limit = payment.limit ? parseFloat(payment.limit+''):0;

        this._sources.push(payment);        
      }

      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
      return this._sources.slice();


    }catch(err){
      throw parseError(err);
    }
  }

  /**
  * ## customer.removeMethod()
  * Remove a payment's method of the customer
  * @param {string} paymentId Stripe id of the source
  * @returns {any} Promise on deletion of the source
  */
  async removeMethod(method:KngCard) {
    const _method = 'removeMethod';
    this.lock(_method);

    try{
      if(!method || !method.id) {
        throw new Error("La méthode de paiement n'est pas valide");
      }
      const index:number= this._sources.findIndex(src => src.id == method.id);

      if (index == -1) {
        throw new Error("Source ID not found:"+method.id);
      }

      const card_id = unxor(method.id);

      //
      // clean in memory default_payment_method
      if(this._default_payment_method == card_id) {
        this._default_payment_method = null;
      }

      //
      // FIXME DEPRECATED, invalid payment method cannot be replaced with this implementation
      // const subs = await $stripe.subscriptions.list({
      //   customer:this._id
      // });      

      // //
      // // verify if payment is used 
      // const payment_used = subs.data.some(sub => sub.default_payment_method == card_id || unxor(sub.metadata.payment_credit)== card_id)
      // if(payment_used) {
      //   throw new Error("Impossible de supprimer une méthode de paiement utilisée par une souscription");
      // }

      //
      // remove credit balance payment method
      // FIXME updating invoice, should not remove balance 
      if(this._sources[index].issuer=='invoice'){
        this._metadata['creditbalance'] = null;
        this._metadata['allowCredit'] = null;
        const customer = await $stripe.customers.update(
          this._id,
          {metadata: this._metadata}
        );
        this._sources.splice(index, 1);
        //
        // put this new customer in cache 4h
        cache.set(this.id,this);
        return;
      }

      //
      // remove vash balance payment method
      if(this._sources[index].issuer=='cash'){
        this._metadata['cashbalance'] = null;
        const customer = await $stripe.customers.update(
          this._id,
          {metadata: this._metadata}
        );
    
        this._sources.splice(index, 1);
        //
        // put this new customer in cache 4h
        cache.set(this.id,this);
        return;
      }
  
      //
      // check the stripe used version
      const isNewImp = (card_id[0] === 'p' && card_id[1] === 'm' && card_id[2] === '_');
  
      //
      // FIXME cannot remove payment used by an active subscription

      //
      // dettach
      let confirmation;
      if(isNewImp) {
        confirmation = await $stripe.paymentMethods.detach(card_id);
        this._sources.splice(index, 1);
  
      }else{
        confirmation = await $stripe.customers.deleteSource(this._id,card_id);
        this._sources.splice(index, 1);
      }

      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
    }catch(err) {
      throw (parseError(err));
    }finally{
      this.unlock(_method);
    }

  }


  // 
  // add credit to a customer
  // FIXME: balance is completly unsecure 
  // use: POST /v1/customers/:uid/balance_transactions { description, amount, currency }
  // dashboard https://dashboard.stripe.com/test/logs/req_wFQcKfjb0TGC8p 
  async updateCredit(amount:number, note?:string) {
    const _method = 'updatecredit';
    this.lock(_method);
    try{

      //
      // 0 amount failed silently
      if(amount == 0) {
        return;
      }

      //
      // max negative credit verification
      if((this.balance + amount)<0) {
        if(!this.allowedCredit()){
          throw new Error("Le paiement par crédit n'est pas disponible");
        }

        //
        // check validity
        const fingerprint = crypto_fingerprint(this.id+this.uid+'invoice');
        const check = await this.checkMethods(false);
        if(check[fingerprint].error) {
          throw new Error(check[fingerprint].error);
        }

        const maxcredit = Config.option('allowMaxCredit')/100;    
        if((this.balance + amount)<(-maxcredit)) {
          throw new Error("Vous avez atteind la limite de crédit de votre compte");
        }
      }

      //
      // max amount credit verification
      const maxamount = Config.option('allowMaxAmount')/100;    
      if((this.balance + amount)>maxamount) {
        throw new Error("Vous avez atteind la limite de votre portefeuille "+maxamount.toFixed(2)+" chf");
      }

      //
      // update customer credit 
      const balance = Math.round((amount+this.balance)*100);

      // FIXME replace updateCredit
      // https://stripe.com/docs/api/customer_balance_transactions/create
      const balanceTransaction = await $stripe.customers.createBalanceTransaction(
        this._id,
        {amount:Math.round(amount*100), currency: 'chf',description:note||''}
      );  

      // const customer = await $stripe.customers.update(
      //   this._id,
      //   {balance}
      // );
      this._balance = balance;

      //
      // put this new customer in cache 4h
      cache.set(this.id,this);      
    }catch(err){
      throw err;
    }finally{
      this.unlock(_method);
    }

    return this;
  }


  async updateIdentity(identity) {
    assert(identity);
    assert(this._metadata.uid);
    assert(this._metadata.fname);
    assert(this._metadata.lname);

    try{
      const updated:any= {
        expand: ['cash_balance'],
        metadata:this._metadata
      };
      if(identity.fname){
        updated.metadata.fname = identity.fname;
      }
      if(identity.lname){
        updated.metadata.lname = identity.lname;
      }

      //
      // USER-ID (FIXME missing strong email verification)
      // this is the default email address
      if(identity.email){
        updated.email = identity.email;
      }

      //
      // USER-ID (FIXME missing strong phone verification)
      // this is the default phone number
      if(identity.phone){
        updated.phone = normalizePhone(identity.phone);
      }

      // avoid update on unit testing 
      if(this._id.indexOf('cus_1234')==-1){
        const customer = await $stripe.customers.update(
          this._id,updated
        );    
  
        this._metadata = customer.metadata;
        this._email = customer.email;
        this._phone = customer.phone;
        this._fname = customer.metadata.fname;
        this._lname = customer.metadata.lname;  
      }

      //
      // put this new customer in cache 4h
      cache.set(this.id,this);
      return this;
    }catch(err) {
      throw parseError(err);
    }     
  }
  
  //
  // atomic methods
  //

  //
  // verify if customer is allowed for credit
  allowedCredit(){
    //
    // this is the signature of an credit authorization
    const fingerprint = crypto_fingerprint(this.id+this.uid+'invoice');

    return this.methods.some(method => method.alias == fingerprint);
  }

  //
  // find a payment method by its id or get the default one (invoice)
  findMethodByID(id) {
    return this._sources.find(card => card.id == id || card.issuer == id);
  }  


  findMethodByAlias(alias) {
    return this._sources.find(card => card.alias == alias);
  }  
}

//
// private function to get metadata keys
function metadataElements(metadata,key) {
  return Object.keys(metadata).filter(k => k.indexOf(key)>-1);
}


//
// private function to decode metadata
function parseAddress(metadata) {
  const keys = metadataElements(metadata,'addr');
  const addresses = [];
  keys.forEach(key => {
    try{
      const address = JSON.parse(metadata[key]) as KngPaymentAddress;
      addresses.push(address);  
    }catch(err){
      console.log('---- DBG error parseAddress',err);
    }
  })
  return addresses;
}


function parseError(err) {
  const error = stripeParseError(err);
  Config.option('debug') && console.log('---- DBG error',error);
  return error;
}

function createCashMethod(_id,uid,month,year) {
  const fingerprint = crypto_fingerprint(_id+uid+'cash');
  const id = crypto_randomToken();
  const mo = parseInt(month);
  if(mo<1 || mo>12 ){
    throw new Error("Incorret month params")
  }
  //
  // if cash balance exist, a updated one is created

  // if(this._metadata['cashbalance']) {
  //   throw new Error("Cash balance already exist");
  // }

  const cashbalance:CashBalance = {
    type:KngPayment.balance,
    id:xor(id),
    alias:(fingerprint),
    expiry:month+'/'+year,
    funding:'debit',
    issuer:'cash'
  }

  return cashbalance;
}

function parseMethod(method, isDefault = false) {
  assert(method);
  const id = xor(method.id);
  method = method.card||method;
  const alias = xor(method.fingerprint);
  // FIXME method type is always 1
  
  return {
    type:parseInt(method.type||1),
    id:id,
    alias:alias,
    country:method.country,
    last4:method.last4,
    issuer:method.brand,
    funding: method.funding,
    fingerprint:method.fingerprint,
    expiry:method.exp_month+'/'+method.exp_year,
    updated:Date.now(),
    provider:'stripe',
    default: isDefault  // ✅ AJOUT: indique si c'est la méthode par défaut
  };

}
