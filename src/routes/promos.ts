import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { applyCouponSchema } from '../schemas';
import { AppError } from '../lib/errors';

const router = Router();

// ─── GET ACTIVE PROMO BANNERS (public) ──────────────────

router.get(
  '/banners',
  asyncHandler(async (_req: Request, res: Response) => {
    const banners = await prisma.promoBanner.findMany({
      where: {
        isActive: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { sortOrder: 'asc' },
    });

    res.json({ success: true, data: banners });
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
      data: {
        code: coupon.code,
        discount,
        newTotal: orderAmount - discount,
      },
    });
  })
);

export default router;
