import Stripe from 'stripe';
import { $stripe, round1cts } from './payments';
import Config from './config';
import type { KngCouponCredit } from './customer';

export interface KngCreateCustomerVaucherOptions {
  code: string;
  amount: number;
  constraint?: string;
}

export interface KngCreatedCustomerVaucher extends KngCouponCredit {
  constraint?: string;
}

function normalizeCode(code: string): string {
  const normalized = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,63}$/.test(normalized)) {
    throw new Error('Le code du coupon est invalide');
  }
  return normalized;
}

function normalizeAmount(amount: number): number {
  const value = Number(amount);
  if (!isFinite(value) || value <= 0 || Math.floor(value) !== value) {
    throw new Error("Le montant du coupon doit être un nombre entier de centimes");
  }
  if (value < 100) {
    throw new Error("Le montant minimum du coupon est de 100 centimes");
  }
  return value;
}

function normalizeConstraint(constraint?: string): string {
  const value = (constraint || '').trim();
  if (!value) {
    return '';
  }
  if (value.length > 128) {
    throw new Error('La contrainte du coupon est trop longue');
  }
  try {
    new RegExp(value, 'i');
  } catch (err) {
    throw new Error("La contrainte du coupon n'est pas une expression régulière valide");
  }
  return value;
}

function toCouponCredit(coupon: Stripe.Coupon): KngCreatedCustomerVaucher {
  const amount = coupon.amount_off || 0;
  return {
    code: coupon.id,
    name: coupon.name || '',
    note: coupon.id + ':' + (coupon.name || ''),
    amount: round1cts(amount / 100),
    amount_off: amount,
    currency: coupon.currency || 'chf',
    constraint: coupon.metadata && coupon.metadata.constraint || ''
  };
}

export async function createVaucher(options: KngCreateCustomerVaucherOptions): Promise<KngCreatedCustomerVaucher> {
  const code = normalizeCode(options.code);
  const amount = normalizeAmount(options.amount);
  const constraint = normalizeConstraint(options.constraint);
  const currency = (Config.option('currency') || 'chf').toLowerCase();

  const coupon = await $stripe.coupons.create({
    id: code,
    name: code,
    amount_off: amount,
    currency,
    duration: 'once',
    metadata: {
      constraint
    }
  });

  return toCouponCredit(coupon);
}
