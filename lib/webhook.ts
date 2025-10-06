import { strict as assert } from 'assert';
import Config from './config';
import Stripe from 'stripe';
import { $stripe, xor } from './payments';
import { Transaction } from './transaction';
import { SubscriptionContract } from './contract.subscription';
import { Customer } from './customer';

export interface WebhookStripe {
  event:string;
  error:boolean;
  balance?:boolean;
  customer?:Customer;
  contract?: SubscriptionContract;
  transaction?: Transaction;
  testing: boolean;
}

export interface WebhookTwilio {
  event:string;
  error:boolean;
}

export class Webhook {



  /**
   * ## retrieve Webhook.stripe(body)
   * Get stripe objects from webhook data
   * https://stripe.com/docs/webhooks
   * @param body - Request body
   * @param sig - Stripe signature header
   * @param mock - Optional mock object with {event?, content?}
   * @returns {WebhookStripe}
   */
   static async stripe(body, sig, mock?):Promise<WebhookStripe> {

    //
    // body = request.data
    // sig = request.headers['STRIPE_SIGNATURE']
    let event = body;
    try{
      // testing webhook controller - use mock event if provided
      if(mock && mock.event) {
        event = mock.event;
      } else {
        const webhookSecret = Config.option('webhookSecret');
        event = $stripe.webhooks.constructEvent(body, sig, webhookSecret);
      }
    }catch(err){
      console.log(`⚠️  Webhook signature verification failed.`, err.message);
      throw err;
    }

    //
    // all events for subscription https://stripe.com/docs/billing/subscriptions/webhooks
    //
    // *** Lifecycle ***
    // - https://stripe.com/docs/billing/subscriptions/overview#subscription-lifecycle
    //
    // ** lors de la pause/unpause
    // customer.subscription.paused
    // customer.subscription.resumed
    // customer.subscription.deleted
    //
    // https://docs.stripe.com/event-destinations#events-overview 
    // customer.subscription.updated (*.updated => previous_attributes)
    //
    // ** normalement c'est uniquement à la création
    // invoice.payment_action_required
    //
    // ** lorsque la carte n'est plus disponible
    // ** smart-retries
    // ** ici https://stripe.com/docs/billing/revenue-recovery/smart-retries
    // ** on peut accepter la commande avec le paiement par facture (option invoice)
    // invoice.payment_failed
    //
    // ** qq jours avant le renouvellement de l'abo
    // invoice.upcoming
    //
    // ** lorsque l'utilisateur a été modifié
    // customer.updated
    // ** lorsque la balance à été modifiée positivement
    // customer.balance_funded
    try {

      //
      // on subscription upcoming 1-3 days before
      if(event.type == 'invoice.upcoming') {
        const invoice = event.data.object as Stripe.Invoice;

        //
        // verify if payment method muste be updated
        // Support both old and new Stripe API structure
        const subscriptionId = invoice.subscription || (invoice as any).parent?.subscription_details?.subscription;
        const contract = await SubscriptionContract.get(subscriptionId);
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, error:false};
        }
        const customer = await contract.customer();        
        return { event: event.type,testing, contract,customer,error:false} as WebhookStripe;
      }

      //
      // clear cache on subscription ending
      // before catching all subscription events
      if(event.type == 'customer.subscription.deleted'){        
        const stripeContract = event.data.object as Stripe.Subscription;
        const customer = await Customer.get(xor(stripeContract.customer.toString()));
        const contract = {
          id: xor(stripeContract.id),
          content: {
            customer:customer.uid
          }
        } as SubscriptionContract;
        SubscriptionContract.clearCache(stripeContract.id);
        return { event: event.type, contract } as WebhookStripe;
      }

      //
      // collect subscription 
      // - customer.subscription.updated
      // - customer.subscription.paused
      // - customer.subscription.resumed
      if(event.type.indexOf('customer.subscription.') > -1) {
        const stripeContract = event.data.object as Stripe.Subscription;
        
        const contract = await SubscriptionContract.get(stripeContract.id.toString());
        contract.previous_attributes = event.data.previous_attributes;

        //
        // be sure of env
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, error:false, contract};
        }
        // get customer
        const customer = await contract.customer();
        return { event: event.type, testing, contract, customer ,error:false} as WebhookStripe;
      }

      // 
      // on invoice payment action required
      // https://stripe.com/docs/billing/subscriptions/webhooks#additional-action
      // send customer e-mail with confirmation requested
      if(event.type == 'invoice.payment_action_required') {
        const invoice = event.data.object as Stripe.Invoice;
        // Support both old and new Stripe API structure
        const subscriptionId = invoice.subscription || (invoice as any).parent?.subscription_details?.subscription;
        const contract = await SubscriptionContract.get(subscriptionId);        
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing,contract, error:false};
        }


        // ✅ FIX: Handle null payment_intent (subscription with no payment method)
        let transaction;
        if(invoice.payment_intent) {
          const paymentIntent = invoice.payment_intent['id'] || invoice.payment_intent;
          transaction = await Transaction.get(xor(paymentIntent));
        }
        const customer = await contract.customer();
        //
        // set pending payment intent, customer have 23h to change payment method

        return { event: event.type ,testing,contract, customer, transaction,error:false} as WebhookStripe;
      }

      // 
      // on invoice payment failed
      // send customer e-mail payment method 
      if(event.type == 'invoice.payment_failed') {
        const invoice = event.data.object as Stripe.Invoice;
        // Support both old and new Stripe API structure
        const subscriptionId = invoice.subscription || (invoice as any).parent?.subscription_details?.subscription;
        const contract = await SubscriptionContract.get(subscriptionId);        
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, contract, error:false};
        }


        // ✅ FIX: Handle null payment_intent (subscription with no payment method)
        let transaction;
        if(invoice.payment_intent) {
          const paymentIntent = invoice.payment_intent['id'] || invoice.payment_intent;
          transaction = await Transaction.get(xor(paymentIntent));
        }
        const customer = await Customer.get(invoice.customer.toString());

        //
        // set pending payment intent, customer have 23h to confirm payment
        return { event: event.type ,testing,contract, customer, transaction,error:false} as WebhookStripe;
      }

      // 
      // 1/ invoice payment success with VISA/MC 
      // 2/ invoice payment success with customer credit
      // only for subscription
      if(event.type == 'invoice.payment_succeeded') {
        const invoice = event.data.object as Stripe.Invoice;

        //
        // be sure that invoice concerne a subscription
        // Support both old and new Stripe API structure
        const subscriptionId = invoice.subscription || (invoice as any).parent?.subscription_details?.subscription;
        if(!subscriptionId) {
          return { event: event.type ,error:false} as WebhookStripe;  
        }

        const contract = await SubscriptionContract.get(subscriptionId);
        //
        // be sure of env
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, error:false};
        }

        let transaction;
        // //
        // // case of invoice
        // if(contract.paymentCredit) {
        // }
        //
        // case of stripe
        if(invoice.payment_intent) {
          transaction = await Transaction.get(xor(invoice.payment_intent.toString()));
        }
        else if(contract.content.latestPaymentIntent){
          const paymentIntentId = contract.content.latestPaymentIntent.id||contract.content.latestPaymentIntent;
          transaction = await Transaction.get(xor(paymentIntentId));
        }
        // ✅ FIX: For invoice.payment_succeeded, if no payment_intent in payload or contract,
        // retrieve it from Stripe API since paid invoices should have a payment_intent
        else {
          try {
            const fullInvoice = await $stripe.invoices.retrieve(invoice.id, {expand: ['payment_intent']});
            if(fullInvoice.payment_intent) {
              transaction = await Transaction.get(xor(fullInvoice.payment_intent.toString()));
            }
          } catch(err) {
            console.warn(`⚠️ Could not retrieve payment_intent for invoice ${invoice.id}:`, err.message);
          }
        }

        const customer = await Customer.get(invoice.customer.toString());

        return { event: event.type , testing,contract, customer, transaction ,error:false} as WebhookStripe;
      }

      //
      // Confirm validity when balance is updated, 
      if (event.type == 'customer.balance_funded') {
        const balance = event.data.object as Stripe.CustomerBalanceTransaction;
        let customer;
        try{
          customer = await Customer.get(xor(balance.customer.toString()));
        }catch(err) {}
        return { event: event.type,testing:false, customer ,error:false} as WebhookStripe;  
      }

      //
      // try to use (POST) customers/cus_id/balance_trasanctions
      // instead of customer.updated
      if (event.type == 'customer.updated'){
        const stripeCustomer = event.data.object as Stripe.Customer;
        let customer, transactions;
        try{
          //
          // update the cache if customer is modified from Stripe
          Customer.clearCache(stripeCustomer.id);
          customer = await Customer.fromWebhook(stripeCustomer);
          customer.previous_attributes = event.data.previous_attributes;

    
          transactions = await customer.listBalanceTransactions(2);
        }catch(err) {
          // Retourner l'erreur pour investigation
          return { event: event.type ,testing: false, customer: null, error: err.message} as WebhookStripe;
        }

        return { event: event.type ,testing: false, customer, error:false} as WebhookStripe;
      }

      //
      //
      // update transaction status for WINT,ApplePay,
      if (event.type =='payment_intent.succeeded' || event.type =='payment_intent.payment_failed') {
        const intent = event.data.object;
        const transaction = await Transaction.get(xor(intent.id));
        const customer = await Customer.get(xor(transaction.customer));
        const error = intent.last_payment_error && intent.last_payment_error.message;
        return { event: event.type ,testing: false, transaction, customer, error} as WebhookStripe;
      }

      //
      // else ...
      console.log(`Unhandled event type ${event.type}`);
      return { event: event.type } as WebhookStripe;
    } catch (err) {
      // On error, log and return the error message
      console.log(`❌ Error message: ${err.message}`);
      throw err;
    }    
  }


  static async twilio(body, sig):Promise<WebhookTwilio>{
    return {} as WebhookTwilio;
  }
      

}
