/**
 * Helper to create mock Stripe subscription webhooks
 * @param {string} eventType - Type of webhook event
 * @param {object} options - Options for customizing the mock
 * @returns {object} Mock objects for testing
 * 
 * FIXME: Pour obtenir des payloads réels par version API Stripe, utiliser Stripe CLI :
 * 
 * 1. Mode écoute (forward vers localhost) :
 *    $ stripe listen --forward-to localhost:3000/webhook
 * 
 * 2. Déclencher un événement spécifique :
 *    $ stripe trigger invoice.payment_succeeded
 *    $ stripe trigger invoice.payment_failed
 * 
 * 3. Avec version API spécifique :
 *    $ stripe trigger invoice.payment_succeeded --api-version 2025-08-27.basil
 * 
 * Cela permet de capturer les vrais payloads webhook par version API.
 * Note: API "Basil" (2025-08-27+) → payment_intent supprimé du payload invoice.*
 */
function stripeSubscription(eventType, options = {}) {
  const baseInvoice = {
    id: options.invoiceId || "in_1SFAj7BTMLb4og7PeGA8KN5c",
    object: "invoice",
    amount_due: options.amountDue || 11300,
    amount_paid: options.amountPaid || 11300,
    amount_remaining: 0,
    billing_reason: "subscription_cycle",
    collection_method: "charge_automatically",
    created: 1759742945,
    currency: "chf",
    customer: options.customerId || "cus_OVy79eFhTBIepa",
    status: "paid",
    subscription: options.subscriptionId || "sub_1S51MvBTMLb4og7PqiKCHOCO",
    lines: {
      data: [
        {
          amount: 5000,
          description: "1 × 1004374 (at CHF 50.00 / every 2 weeks)",
          metadata: {
            dayOfWeek: "2",
            uid: options.userId || "570535797775787"
          },
          parent: {
            subscription_item_details: {
              subscription: options.subscriptionId || "sub_1S51MvBTMLb4og7PqiKCHOCO"
            }
          }
        }
      ]
    }
  };

  const basePaymentIntent = {
    id: options.paymentIntentId || "pi_1SFAj7BTMLb4og7Pmock123",
    object: "payment_intent",
    status: "succeeded",
    amount: 11300,
    currency: "chf",
    customer: options.customerId || "cus_OVy79eFhTBIepa",
    payment_method: options.paymentMethodId || "pm_1234567890",
    last_payment_error: options.lastPaymentError || null
  };

  // Create mock instances that will be used by the tests
  const mockContract = {
    id: options.subscriptionId || "sub_1S51MvBTMLb4og7PqiKCHOCO",
    content: {
      id: options.subscriptionId || "sub_1S51MvBTMLb4og7PqiKCHOCO",
      customer: options.karibouCustomerId || "12345",
      latestPaymentIntent: null // Will be set per event type
    },
    environnement: options.environnement || 'production',
    customer: async function() {
      return mockCustomer;
    }
  };

  const mockCustomer = {
    id: options.customerId || "cus_OVy79eFhTBIepa",
    uid: options.karibouCustomerId || "12345",
    email: {
      address: options.customerEmail || "mock-test@example.com"
    }
  };

  const mockTransaction = {
    id: basePaymentIntent.id,
    status: "succeeded",
    customerCredit: 0,
    ...options.transactionOverrides
  };

  switch (eventType) {
    case 'payment_intent.succeeded':
      mockContract.content.latestPaymentIntent = {
        id: basePaymentIntent.id,
        status: 'succeeded'
      };
      mockTransaction.status = 'succeeded';

      return {
        event: {
          type: 'payment_intent.succeeded',
          data: {
            object: {
              ...basePaymentIntent,
              status: 'succeeded',
              invoice: options.subscriptionId ? baseInvoice.id : null,
              metadata: options.subscriptionId ? {
                subscription: options.subscriptionId
              } : {},
              ...options.paymentIntentOverrides
            }
          }
        },
        mockContract,
        mockCustomer,
        mockTransaction
      };

    case 'invoice.payment_failed':
      mockContract.content.latestPaymentIntent = {
        id: basePaymentIntent.id,
        status: 'requires_payment_method'
      };
      mockTransaction.status = 'requires_payment_method';
      mockTransaction.last_payment_error = {
        type: 'card_declined',
        message: 'Your card was declined.',
        code: 'card_declined'
      };

      return {
        event: {
          type: 'invoice.payment_failed',
          data: {
            object: {
              ...baseInvoice,
              status: 'open',
              amount_paid: 0,
              amount_remaining: options.amountDue || 11300,
              payment_intent: basePaymentIntent.id,
              ...options.invoiceOverrides
            }
          }
        },
        mockContract,
        mockCustomer,
        mockTransaction
      };

    case 'invoice.payment_action_required':
      mockContract.content.latestPaymentIntent = {
        id: basePaymentIntent.id,
        status: 'requires_action',
        client_secret: 'pi_123_secret_456'
      };
      mockTransaction.status = 'requires_action';
      mockTransaction.client_secret = 'pi_123_secret_456';
      mockTransaction.next_action = {
        type: 'use_stripe_sdk',
        use_stripe_sdk: {
          type: 'three_d_secure_redirect',
          stripe_js: 'https://js.stripe.com/v3/',
          directory_server_txn_id: '12345678-1234-1234-1234-123456789012',
          three_d_secure: {
            url: 'https://acs.example.com/3ds'
          }
        }
      };

      return {
        event: {
          type: 'invoice.payment_action_required',
          data: {
            object: {
              ...baseInvoice,
              status: 'open',
              amount_paid: 0,
              amount_remaining: options.amountDue || 11300,
              payment_intent: basePaymentIntent.id,
              ...options.invoiceOverrides
            }
          }
        },
        mockContract,
        mockCustomer,
        mockTransaction
      };

    case 'invoice.payment_succeeded':
    default:
      // No payment intent in contract (real scenario - will be retrieved from Stripe API)
      mockContract.content.latestPaymentIntent = null;
      mockTransaction.status = 'succeeded';

      // Build invoice object with optional parent.subscription_details
      const invoiceObject = {
        ...baseInvoice,
        status: 'paid',
        amount_paid: options.amountDue || 11300,
        amount_remaining: 0,
        // Note: No payment_intent in payload (real scenario)
        ...options.invoiceOverrides
      };

      // Add parent.subscription_details if requested (new Stripe API structure)
      if (options.useParentSubscriptionDetails) {
        invoiceObject.parent = {
          quote_details: null,
          subscription_details: {
            metadata: {
              address: "{}",
              dayOfWeek: "2",
              fees: "0.06",
              plan: "customer",
              uid: options.userId || "570535797775787"
            },
            subscription: options.subscriptionId || "sub_1S51MvBTMLb4og7PqiKCHOCO"
          },
          type: "subscription_details"
        };
        // Remove the top-level subscription field to simulate new API structure
        delete invoiceObject.subscription;
      }

      return {
        event: {
          type: 'invoice.payment_succeeded',
          data: {
            object: invoiceObject
          }
        },
        mockContract,
        mockCustomer,
        mockTransaction,
        stripeApiMock: {
          invoiceId: options.invoiceId || "in_1SFAj7BTMLb4og7PeGA8KN5c",
          paymentIntentId: basePaymentIntent.id
        }
      };
  }
}

module.exports = {
  stripeSubscription
};
