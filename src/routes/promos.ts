import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, requireRole } from '../middleware/auth';
import { applyCouponSchema } from '../schemas';
import { AppError } from '../lib/errors';

const router = Router();

// Curated rider promos shown when no active rider banners are configured yet.
const DEFAULT_RIDER_PROMOS = [
  { id: 'default-start', slug: 'start-delivering', title: 'Start delivering', subtitle: 'Go online and accept your first request today.', body: 'Toggle Go Online and nearby paid orders will appear for you to accept.', theme: 'violet', audience: 'RIDER', imageUrl: null, illustration: null, ctaLabel: 'See requests', ctaDeepLink: '/rider/orders', linkUrl: '/rider/orders', priority: 100, sortOrder: 0 },
  { id: 'default-refer', slug: 'refer-earn', title: 'Refer & Earn ₦1,000', subtitle: 'Invite a friend — you both earn when they complete their first delivery.', body: 'Share your code. When your friend finishes their first delivery, you both get ₦1,000.', theme: 'lime', audience: 'RIDER', imageUrl: null, illustration: null, ctaLabel: 'Invite friends', ctaDeepLink: '/rider/referrals', linkUrl: '/rider/referrals', priority: 90, sortOrder: 1 },
  { id: 'default-bonus', slug: 'ride-earn-bonus', title: 'Ride & Earn Bonus', subtitle: 'Complete 10 deliveries. Earn a ₦5,000 bonus.', body: 'Hit 10 completed deliveries this week to unlock a ₦5,000 bonus on top of your earnings.', theme: 'deepViolet', audience: 'RIDER', imageUrl: null, illustration: null, ctaLabel: 'Start delivering', ctaDeepLink: '/rider/orders', linkUrl: '/rider/orders', priority: 80, sortOrder: 2 },
  { id: 'default-payout', slug: 'fast-payouts', title: 'Fast payouts', subtitle: 'Cash out your earnings to your bank anytime.', body: 'Add a verified bank account and request a payout whenever you like.', theme: 'teal', audience: 'RIDER', imageUrl: null, illustration: null, ctaLabel: 'View earnings', ctaDeepLink: '/rider/earnings', linkUrl: '/rider/earnings', priority: 70, sortOrder: 3 },
  { id: 'default-performance', slug: 'boost-rating', title: 'Boost your rating', subtitle: 'Keep acceptance high and cancellations low.', body: 'A strong acceptance rate and low cancellations get you more requests.', theme: 'magenta', audience: 'RIDER', imageUrl: null, illustration: null, ctaLabel: 'View account', ctaDeepLink: '/rider/account', linkUrl: '/rider/account', priority: 60, sortOrder: 4 },
];

/** Active promos for an audience, highest-priority / newest first. */
async function activePromos(audience: string) {
  const now = new Date();
  return prisma.promoBanner.findMany({
    where: {
      isActive: true,
      audience: { in: [audience, 'ALL'] },
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: [{ priority: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

// ─── GET ACTIVE PROMO BANNERS (public) ──────────────────
// ?audience=RIDER|CUSTOMER|ALL (default ALL). Falls back to curated rider
// promos when none are configured yet.
router.get(
  '/banners',
  asyncHandler(async (req: Request, res: Response) => {
    const audience = String(req.query.audience || 'ALL').toUpperCase();
    const banners = await activePromos(audience);
    if (banners.length === 0 && audience === 'RIDER') {
      return res.json({ success: true, data: DEFAULT_RIDER_PROMOS });
    }
    res.json({ success: true, data: banners });
  })
);

// ─── CREATE A PROMO (admin) ─────────────────────────────
router.post(
  '/banners',
  authenticate,
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as Record<string, any>;
    if (!b.title) throw new AppError('A title is required', 400);
    const banner = await prisma.promoBanner.create({
      data: {
        slug: b.slug || undefined,
        title: b.title,
        subtitle: b.subtitle || null,
        body: b.body || null,
        imageUrl: b.imageUrl || null,
        illustration: b.illustration || null,
        linkUrl: b.linkUrl || b.ctaDeepLink || null,
        ctaLabel: b.ctaLabel || null,
        ctaDeepLink: b.ctaDeepLink || null,
        theme: b.theme || null,
        audience: ['ALL', 'RIDER', 'CUSTOMER'].includes(b.audience) ? b.audience : 'ALL',
        isActive: b.isActive !== false,
        priority: typeof b.priority === 'number' ? b.priority : 0,
        sortOrder: typeof b.sortOrder === 'number' ? b.sortOrder : 0,
        validFrom: b.validFrom ? new Date(b.validFrom) : null,
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
      },
    });
    res.status(201).json({ success: true, data: banner });
  })
);

// ─── UPDATE / DEACTIVATE A PROMO (admin) ────────────────
router.patch(
  '/banners/:id',
  authenticate,
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as Record<string, any>;
    const data: Record<string, any> = {};
    for (const k of ['slug', 'title', 'subtitle', 'body', 'imageUrl', 'illustration', 'linkUrl', 'ctaLabel', 'ctaDeepLink', 'theme', 'audience', 'isActive', 'priority', 'sortOrder']) {
      if (b[k] !== undefined) data[k] = b[k];
    }
    if (b.validFrom !== undefined) data.validFrom = b.validFrom ? new Date(b.validFrom) : null;
    if (b.expiresAt !== undefined) data.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    const banner = await prisma.promoBanner.update({ where: { id: String(req.params.id) }, data });
    res.json({ success: true, data: banner });
  })
);

// ─── VALIDATE & CALCULATE COUPON DISCOUNT ───────────────
router.post(
  '/coupons/apply',
  authenticate,
  validate(applyCouponSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { code, orderAmount } = req.body;

    const coupon = await prisma.coupon.findUnique({ where: { code } });

    if (!coupon) throw new AppError('Invalid coupon code', 404);
    if (!coupon.isActive) throw new AppError('Coupon is no longer active', 400);
    if (coupon.expiresAt < new Date()) throw new AppError('Coupon has expired', 400);
    if (coupon.currentUses >= coupon.maxUses) throw new AppError('Coupon usage limit reached', 400);
    if (orderAmount < coupon.minOrderAmount) {
      throw new AppError(`Minimum order of ₦${coupon.minOrderAmount} required`, 400);
    }

    let discount = 0;
    if (coupon.discountPercent) {
      discount = Math.round(orderAmount * (coupon.discountPercent / 100));
    } else if (coupon.discountFlat) {
      discount = Math.min(coupon.discountFlat, orderAmount);
    }

    res.json({
      success: true,
      data: { code: coupon.code, discount, newTotal: orderAmount - discount },
    });
  })
);

export default router;
