![build](https://github.com/karibou-ch/karibou-wallet/actions/workflows/node.js.yml/badge.svg)

# Soutenez le développement des logiciels de Karibou.ch 🤗

[![k-dev-md](https://github.com/karibou-ch/karibou-wallet/assets/1422935/1bc0ad0b-0797-4a1a-a308-1e732bdcaa4c)](https://karibou.ch)


Nous sommes sincèrement reconnaissants envers nos soutiens qui rendent ce projet possible. 
Votre générosité nous permet de continuer à développer et à améliorer nos logiciels tout en les maintenants en libre accès.

En tant que soutien, vous bénéficierez de nombreux avantages, notamment :

- Accès exclusif aux cycles de financement futurs avec la possibilité de participer.
- Accès privilégié aux produits à venir de Karibou.ch sur Ethereum.
- Reconnaissance bien méritée dans nos crédits et sur notre page Karibou.ch.

Rejoignez sans plus tarder notre communauté de soutiens sur Karibou.ch et participez à l'évolution de ce projet !

[Devenir un Soutien Karibou.ch](lien_vers_votre_page_karibou)



# Karibou Wallet
## Main usage

The purpose of this project is to provide a simple and intuitive API to handle a simple Wallet manager for our karibou.ch marketplace. It has bean designed to work on server side and it's usefull for,
* [x] Stripe payment (card, SEPA, ...)
* [x] Initial debit balance account
  * [X] payment can be made with customer balance and completed with card 
* [x] Initial credit balance account (for invoice)
* [x] Two step payment and (partial) refund (authorization, capture, refund)
* [ ] Multiple accounts transfer funds (**DOING**)
* [x] Subscription (weekly, monthly)
  * [x] with payment method `visa/mc/invoice/cash`
  * [X] with products or services
  * [X] pause and resume
  * [X] build and sent invoices
  * [X] manage SCA and other F**ING security scheme
  * [ ] update contract items (add/update or remove specifics items)
* [x] Initial Customer management to protect sensitives data
  * [x] sensitives data are decoupled from karibou
  * [ ] email, phone 
  * [x] fname, lname
  * [ ] addresses
  * [x] payment methods
* [ ] Advanced signin verification (Identity)  (**TODO**)
  * [ ] verify from email/password
  * [ ] verify from inbox email (OTP)
  * [ ] verify from sms (OTP)
  * [ ] verify from public key (web3/btc)
* [x] Initial transfer monney via COUPON 
  * [X] coupon can be load in customer wallet
  * [ ] coupon is limited to a vendor


## Prerequisites
install node.js with [NVM](https://github.com/nvm-sh/nvm#installing-and-updating) (required). 

    nvm install v18.x
    nvm use v8.x

## Installation
From github,    

    git clone https://github.com/evaletolab/karibou-wallet
    cd karibou-wallet

Easiest way to install karibou-wallet is by using npm *(not yet ready for production)*:

    npm install --save karibou-wallet


## Running unit tests

To run unit tests you need [Mocha](https://github.com/visionmedia/mocha),
and [should.js](https://github.com/visionmedia/should.js). The tests are run simply by simply typing:

    NODE_ENV=test npx mocha

Do not run tests with your live processor. Make sure you are running in a
sandbox.


[![logo k-dev](https://github.com/karibou-ch/karibou-wallet/assets/1422935/9bd35736-0388-4629-816c-ef63f0773c58)](https://karibou.ch)

## License
The API is available under AGPL V3 to protect the long term interests of the community – you are free to use it with no restrictions but if you change the server code, then those code changes must be contributed back.

> Copyright (c) 2014 Olivier Evalet (https://karibou.ch/)<br/>
> <br/><br/>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the “Software”), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
> <br/>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
> <br/>
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.
