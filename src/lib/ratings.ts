import prisma from './prisma';
import { AppError } from './errors';

export type RatingKind = 'RIDER' | 'CUSTOMER' | 'APP';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Recompute a rider's average + count from all RIDER ratings they've received. */
export async function recomputeRiderRating(riderProfileId: string) {
  const agg = await prisma.rating.aggregate({
    where: { type: 'RIDER', riderProfileId },
    _avg: { score: true },
    _count: { _all: true },
  });
  await prisma.riderProfile.update({
    where: { id: riderProfileId },
    data: { avgRating: round1(agg._avg.score ?? 0), ratingCount: agg._count._all },
  });
}

/** Recompute a customer's average + count from all CUSTOMER ratings they've received. */
export async function recomputeCustomerRating(userId: string) {
  const agg = await prisma.rating.aggregate({
    where: { type: 'CUSTOMER', ratedUserId: userId },
    _avg: { score: true },
    _count: { _all: true },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { customerRating: round1(agg._avg.score ?? 0), customerRatingCount: agg._count._all },
  });
}

/**
 * Submit a rating of any kind. Enforces authorisation (only the customer rates
 * the rider; only the assigned rider rates the customer), one-rating-per-pair,
 * and keeps the rolling average + count on the rated party in sync.
 */
export async function submitRating(opts: {
  kind: RatingKind;
  raterId: string;
  deliveryId?: string | null;
  score: number;
  comment?: string | null;
}) {
  const { kind, raterId, score } = opts;
  const comment = opts.comment?.toString().trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new AppError('Score must be a whole number from 1 to 5', 400);
  }

  // ── App experience rating (no rated party) ──
  if (kind === 'APP') {
    if (opts.deliveryId) {
      const dup = await prisma.rating.findFirst({ where: { type: 'APP', deliveryId: opts.deliveryId, raterId } });
      if (dup) throw new AppError('You already rated the app for this trip', 409);
    }
    return prisma.rating.create({
      data: { type: 'APP', deliveryId: opts.deliveryId ?? null, raterId, score, comment },
    });
  }

  // ── Delivery-bound ratings (RIDER / CUSTOMER) ──
  if (!opts.deliveryId) throw new AppError('deliveryId is required', 400);
  const delivery = await prisma.delivery.findUnique({
    where: { id: opts.deliveryId },
    select: { id: true, status: true, customerId: true, riderId: true, rider: { select: { userId: true } } },
  });
  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.status !== 'DELIVERED') throw new AppError('You can only rate a completed delivery', 400);

  if (kind === 'RIDER') {
    if (delivery.customerId !== raterId) throw new AppError('Only the customer can rate the rider', 403);
    if (!delivery.riderId) throw new AppError('There is no rider to rate', 400);
    const dup = await prisma.rating.findFirst({ where: { type: 'RIDER', deliveryId: delivery.id, raterId } });
    if (dup) throw new AppError('You already rated your rider for this trip', 409);
    const rating = await prisma.rating.create({
      data: { type: 'RIDER', deliveryId: delivery.id, raterId, riderProfileId: delivery.riderId, ratedUserId: delivery.rider?.userId ?? null, score, comment },
    });
    await recomputeRiderRating(delivery.riderId);
    return rating;
  }

  // CUSTOMER
  if (!delivery.rider?.userId || delivery.rider.userId !== raterId) {
    throw new AppError('Only the assigned rider can rate the customer', 403);
  }
  const dup = await prisma.rating.findFirst({ where: { type: 'CUSTOMER', deliveryId: delivery.id, raterId } });
  if (dup) throw new AppError('You already rated this customer for this trip', 409);
  const rating = await prisma.rating.create({
    data: { type: 'CUSTOMER', deliveryId: delivery.id, raterId, ratedUserId: delivery.customerId, score, comment },
  });
  // Mirror onto the delivery for quick lookups / back-compat.
  await prisma.delivery.update({ where: { id: delivery.id }, data: { riderRatedScore: score, riderRatedComment: comment } });
  await recomputeCustomerRating(delivery.customerId);
  return rating;
}

/** Average, count and 1-5 star breakdown for any rating filter. */
export async function ratingSummary(where: any) {
  const [agg, rows] = await Promise.all([
    prisma.rating.aggregate({ where, _avg: { score: true }, _count: { _all: true } }),
    prisma.rating.groupBy({ by: ['score'], where, _count: { _all: true } }),
  ]);
  const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) breakdown[r.score] = r._count._all;
  return { average: round1(agg._avg.score ?? 0), count: agg._count._all, breakdown };
}

const REVIEW_SELECT = {
  score: true,
  comment: true,
  createdAt: true,
  rater: { select: { firstName: true, lastName: true, avatarUrl: true } },
} as const;

export function listReviews(where: any, take = 20) {
  return prisma.rating.findMany({ where, orderBy: { createdAt: 'desc' }, take, select: REVIEW_SELECT });
}
