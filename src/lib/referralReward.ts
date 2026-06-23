import prisma from './prisma';
import { emitNotification } from '../socket';

export const REFERRAL_BONUS = 1000;

/**
 * Called right after a delivery transitions to DELIVERED. If the order's
 * customer was referred and this is their FIRST completed delivery, complete
 * the referral and credit the referrer's wallet with the bonus.
 */
export async function maybeRewardReferral(customerId: string): Promise<void> {
  const referral = await prisma.referral.findFirst({
    where: { referredId: customerId, status: { not: 'COMPLETED' } },
  });
  if (!referral) return;

  // Count includes the delivery that just completed — 1 means it's the first.
  const deliveredCount = await prisma.delivery.count({
    where: { customerId, status: 'DELIVERED' },
  });
  if (deliveredCount > 1) return;

  await prisma.referral.update({
    where: { id: referral.id },
    data: { status: 'COMPLETED', isPaid: true, bonusAmount: REFERRAL_BONUS, completedAt: new Date() },
  });

  await prisma.wallet.upsert({
    where: { userId: referral.referrerId },
    create: { userId: referral.referrerId, balance: REFERRAL_BONUS },
    update: { balance: { increment: REFERRAL_BONUS } },
  });

  emitNotification(referral.referrerId, {
    type: 'REFERRAL',
    title: 'Referral reward earned',
    body: `Your friend completed their first delivery — you've earned ₦${REFERRAL_BONUS.toLocaleString()}.`,
  });
}
