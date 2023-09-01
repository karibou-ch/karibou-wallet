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
        const customer = await contract.customer();        
        return { event: event.type,contract,customer,error:false} as WebhookStripe;
      }

      // 
      // on invoice payment failed
      if(event.type == 'invoice.payment_failed') {
        const invoice = event.data.object as Stripe.Invoice;
        const transaction = await Transaction.get(xor(invoice.payment_intent.toString()));
        const contract = await SubscriptionContract.get(invoice.subscription);
        const customer = await contract.customer();
        return { event: event.type ,contract, customer, transaction,error:false} as WebhookStripe;
      }


      // 
      // on invoice payment success with VISA/MC
      // only for subscription
      if(event.type == 'invoice.payment_succeeded' && event.data.object.payment_intent) {
        const invoice = event.data.object as Stripe.Invoice;
        const transaction = await Transaction.get(xor(invoice.payment_intent.toString()));
        //
        // be sure that invoice concerne a subscription
        if(!invoice.subscription) {
          return { event: event.type, transaction ,error:false} as WebhookStripe;  
        }


        const contract = await SubscriptionContract.get(invoice.subscription);
        const customer = await contract.customer();

        //
        // finalement update le status as PREPAID pour l'afficher dans l'application
        await transaction.updateStatusPrepaid();

        return { event: event.type ,contract, customer, transaction ,error:false} as WebhookStripe;
      }

      // 
      // on invoice payment success with customer credit
      if(event.type == 'invoice.payment_succeeded' && !event.data.object.payment_intent) {
        const invoice = event.data.object as Stripe.Invoice;

        const contract = await SubscriptionContract.get(invoice.subscription);
        const customer = await contract.customer();

        return { event: event.type ,contract, customer ,error:false} as WebhookStripe;
      }

      //
      // Confirm validity when balance is updated, 
      if (event.type == 'customer.balance_funded') {
        const balance = event.data.object as Stripe.CustomerBalanceTransaction;
        const customer = await Customer.get(balance.customer);
        return { event: event.type ,customer ,error:false} as WebhookStripe;
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
