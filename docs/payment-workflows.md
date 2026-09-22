# Workflows de paiement Karibou

Source de vérité pour create / update / 3DS / save carte / renouvellement.
Code : `lib/contract.subscription.ts`, `lib/customer.ts`, `lib/transaction.ts`.
Métier abo + commandes webhook : `karibou-api.wiki/1.4-Paiement-par-souscription.md`.

## Principes

1. **Session si le client est là, async s’il n’y est plus.** Un achat direct se confirme en session. Un charge hors session (fin de trial, renouvellement, client parti) se valide via `latest_invoice` + mail / `hosted_invoice_url`.
2. **Le wallet ne confirme jamais un PaymentIntent de facture.** Pas de `$stripe.paymentIntents.confirm` dans `create`, `update`, `updatePaymentMethod`, `resetBillingCycle`. Le front : `confirmCardPayment(client_secret)`.
3. **Deux objets Stripe, deux jobs.** Ne pas les fusionner.

| Objet | Quand | Front |
|---|---|---|
| PaymentIntent (`latest_invoice`) | charge **cette** facture | `confirmCardPayment` |
| SetupIntent (`pending_setup_intent` ou `addMethodIntent`) | mandat **futur** (MIT) | `confirmCardSetup` |

`subscriptions.create({ off_session: false })` = client présent pour **ce** charge. Ce n’est **pas** le mandat carte. Le mandat = `SetupIntent.usage: 'off_session'`.

4. **TWINT n’existe pas sur les souscriptions.** `create` refuse `card.type == 'twint'`. TWINT = achat direct only (redirect + retour `?payment_intent&oid`).
5. **`issuer=invoice` est un fallback Karibou, hors Stripe.** Pas de PaymentIntent, pas de 3DS, pas de SetupIntent. `payment_behavior: allow_incomplete`, `metadata.payment_credit=invoice`. Ne pas y appliquer `automatic_payment_methods` ni `default_payment_method`.
6. **Carte Stripe abo : `customer.invoice_settings.default_payment_method`.** Ne pas poser `subscription.default_payment_method`.
7. **Update items / ancre : pas de 3DS UI.** `proration_behavior: none`. Si Stripe facture quand même (`reset('now')`), recovery = mail, pas un modal dans l’éditeur.
8. **`resetBillingCycle` / `pause` exigent un abo `active` (ou `trialing`).** Stripe refuse `billing_cycle_anchor` / `trial_end` sur `incomplete` (nouvelle facture interdite).

## Cartes de test

| Carte | Rôle |
|---|---|
| `4242424242424242` | Pas de challenge 3DS (non enrôlée). Un `paymentIntents.confirm` secret-key en mocha = stand-in de `confirmCardPayment`, **pas** un test 3DS. |
| `4000000000003220` | 3DS required. Mocha s’arrête à `requires_confirmation` \| `requires_action` + `client_secret`. |
| `4000000000000341` | Attach OK, charge refusée → `requires_payment_method`. |

## Arbre

```
Paiement
│
├─ 0. SAVE CARTE (profil)                    on-session
│     addMethodIntent(usage:off_session)
│     → confirmCardSetup
│
├─ A. ACHAT DIRECT (one-shot)
│     ├─ A1. Carte, client là                confirmCardPayment → authorized → order
│     ├─ A2. TWINT / wallet / redirect       leave page → retour ?payment_intent&oid
│     └─ A3. invoice interne                 hors Stripe, pas de 3DS
│
├─ B. SUB CREATE
│     ├─ B1. start = now                     latest_invoice.PI
│     │     ├─ B1a. client reste             confirmCardPayment → active
│     │     ├─ B1b. client part              incomplete 23h → mail → même PI
│     │     └─ B1c. carte morte              requires_payment_method
│     ├─ B2. start = futur (trial_end)
│     │     pas de PI facture
│     │     ├─ B2a. MAINTENANT               pending_setup_intent → confirmCardSetup
│     │     └─ B2b. FIN DE TRIAL             charge MIT off-session
│     │           OK → invoice.paid → commande prepaid
│     │           3DS → mail → confirmCardPayment
│     │           refus → mail remplacer carte
│     └─ B3. issuer=invoice                  hors Stripe
│
├─ C. SUB UPDATE (éditeur / admin)           3DS UI interdit
│     ├─ C1. items / dayOfWeek               pas de facture maintenant
│     ├─ C2. reset / pause futur             trial_end, pas de charge
│     ├─ C3. reset('now')                    Stripe peut facturer → MIT ou mail (C = D)
│     └─ C4. updatePaymentMethod + PI ouvert attach PM, confirm au front
│
└─ D. RENOUVELLEMENT                         = B2b, toujours off-session
```

## Chemins

### 0 — Save carte

Wallet : `Customer.addMethodIntent()` → SetupIntent `usage: off_session`.
Front : `confirmCardSetup` puis `addMethod` (default customer).
Hors sujet du charge de facture.

### A1 — Achat direct, session

Wallet prépare le PI (`capture_method: manual` si 2-steps). Front : `confirmCardPayment` puis `doOrder`. Pas de confirm Node.

### A2 — Achat direct, async (TWINT / redirect)

TWINT et wallets : le client quitte la page. Retour `?payment_intent&oid` → `waitForPaymentOrder`. **Interdit sur subscription.**

### A3 / B3 — invoice

Custom Karibou. Aucune API Stripe PaymentIntent / SetupIntent. Ne pas « corriger » avec de la SCA Stripe.

### B1 — Sub start now

Wallet : `create(..., 'now')`, `payment_behavior: default_incomplete`, `off_session: false`, expand PI + `pending_setup_intent`. PI ouvert, pas de confirm Node.

Front checkout : `confirmCardPayment` si status `requires_confirmation` **ou** `requires_action` (le PI non confirmé est souvent `requires_confirmation`).

Si le client part : webhook `invoice.payment_action_required` → mail vers l’écran paiement **et** `hosted_invoice_url`. Même `client_secret`. Délai 23 h puis `incomplete_expired`.

`onConfirmPaymentIntent` : uniquement `client_secret`. Ne pas renvoyer `payment_method` si le PI l’a déjà.

### B2 — Sub start futur (`trial_end`)

Wallet : `trial_end = timestamp`. Pas de PI de facture. Expose `pendingSetupIntent.client_secret`.

**B2a (session).** Front : `confirmCardSetup(pendingSetupIntent.client_secret)`. Sans ça, B2b sera un 3DS à froid. Le checkout ne doit pas ignorer `pendingSetupIntent`.

**B2b (off-session, fin de trial).** Stripe facture. Pas de front. OK → `invoice.paid` → commande prepaid. 3DS → même mail / même PI que B1b. Refus → `invoice.payment_failed`.

Le mail n’est pas un plan B du create now. C’est le **seul** chemin 3DS du premier vrai cycle.

### C — Update

`update()` : items + metadata, `proration: none`, pas de confirm Node.
Pas de `confirmCardPayment` dans l’éditeur d’items.
C3 (`reset('now')`) : si facture + 3DS → mail (D).
C4 : seul cas « session paiement » sur un update : PI encore ouvert (`paymentIntents.update` pour attacher, confirm au front).

### D — Renouvellement

Identique à B2b. Wallet n’intervient pas au charge. API : webhooks `invoice.paid` / `payment_action_required` / `payment_failed`.

## Surfaces front

| Surface | Rôle |
|---|---|
| Achat / abo | panier, date, items, `dayOfWeek`. Jamais de modal 3DS. |
| Action paiement | un secret (PI **ou** SetupIntent), un bouton. Checkout (session) ou `?action=authenticate&intent=` (async). |

Checkout après create : `pendingSetupIntent` → Setup ; `latestPaymentIntent` ouvert → Payment.

## Webhooks (API, pas wallet)

| Event | Action |
|---|---|
| `invoice.payment_succeeded` | commande prepaid (contrat Karibou) |
| `invoice.payment_action_required` | mail 3DS seulement si PI + `client_secret` + status `requires_action` ; idéalement `hosted_invoice_url` |
| `invoice.payment_failed` | mail erreur / remplacer carte ; pas de commande sauf crédit interne documenté |

## Interdit

- `paymentIntents.confirm` dans le wallet sur un PI de facture abo
- TWINT / `automatic_payment_methods` sur une subscription
- Attacher `subscription.default_payment_method` (stratégie customer default)
- Traiter `issuer=invoice` comme un flux Stripe
- Confirmer un 3DS dans l’éditeur d’items ou `resetBillingCycle`
- Tester le 3DS en mocha avec un confirm secret-key sur `3220` puis attendre `succeeded`
- `resetBillingCycle` sur un abo `incomplete` (fixture : activer d’abord via stand-in 4242)
