import prisma from './prisma';

/**
 * Generate a unique order tag like ORD001, ORD002, etc.
 */
export async function generateOrderTag(): Promise<string> {
  const count = await prisma.delivery.count();
  const num = count + 1;
  return `ORD${num.toString().padStart(3, '0')}`;
}

/**
 * Generate a 4-digit hand-off verification code (pickup / dropoff).
 */
export function generateCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Generate a referral code from user name or random
 */
export function generateReferralCode(firstName?: string): string {
  const prefix = firstName ? firstName.slice(0, 4).toUpperCase() : 'TUNL';
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${suffix}`;
}
