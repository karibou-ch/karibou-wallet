import { strict as assert } from 'assert';
import Stripe from 'stripe';
import { $stripe, xor } from './payments';
import Config from './config';
import { Transaction } from './transaction';
import { SubscriptionContract } from './contract.subscription';
import { Customer } from './customer';

export interface WebhookStripe {
  event:string;
  error:boolean;
  balance?:boolean;
  customer?:Customer;
  subscription?: SubscriptionContract;
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
  * @returns {WebhookStripe } 
  */
   static async stripe(body, sig):Promise<WebhookStripe> {

    // 
    // body = request.data
    // sig = request.headers['STRIPE_SIGNATURE']
    let event = body;
    try{
      const webhookSecret = Config.option('webhookSecret');
      event = $stripe.webhooks.constructEvent(body, sig, webhookSecret);
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
        const contract = await SubscriptionContract.get(invoice.subscription);
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, error:false};
        }
        const customer = await contract.customer();        
        return { event: event.type,testing, contract,customer,error:false} as WebhookStripe;
      }

      //
      // clear cache on subscription ending
      if(event.type == 'customer.subscription.deleted'){        
        const stripe = event.data.object as Stripe.Subscription;
        const subscription = await SubscriptionContract.get(stripe.id)
        SubscriptionContract.clearCache(stripe.id);
        return { event: event.type, subscription } as WebhookStripe;
      }
      // 
      // on invoice payment action required
      // https://stripe.com/docs/billing/subscriptions/webhooks#additional-action
      // send customer e-mail with confirmation requested
      if(event.type == 'invoice.payment_action_required') {
        const invoice = event.data.object as Stripe.Invoice;
        const contract = await SubscriptionContract.get(invoice.subscription);        
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, error:false};
        }


        const paymentIntent = invoice.payment_intent.toString();
        const transaction = await Transaction.get(xor(paymentIntent));
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
        const contract = await SubscriptionContract.get(invoice.subscription);        
        const testing = (contract.environnement == 'test')
        if(testing) {
          return { event: event.type,testing, error:false};
        }


        const paymentIntent = invoice.payment_intent.toString();
        const transaction = await Transaction.get(xor(paymentIntent));
        const customer = await contract.customer();
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
        if(!invoice.subscription) {
          return { event: event.type ,error:false} as WebhookStripe;  
        }

        const contract = await SubscriptionContract.get(invoice.subscription);
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
        if(contract.latestPaymentIntent){
          transaction = await Transaction.get(xor(contract.latestPaymentIntent.id));
          //
          // use  PREPAID for active order on workflow
          await transaction.updateStatusPrepaid();
        }

        const customer = await contract.customer();

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
    
          transactions = await customer.listBalanceTransactions(2);
        }catch(err) {}

        return { event: event.type ,testing: false, customer, error:false} as WebhookStripe;
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
