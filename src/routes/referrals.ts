import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// ─── GET MY REFERRAL INFO ───────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { referralCode: true },
    });

    const [totalReferrals, paidReferrals, totalEarned] = await Promise.all([
      prisma.referral.count({ where: { referrerId: req.user!.userId } }),
      prisma.referral.count({ where: { referrerId: req.user!.userId, isPaid: true } }),
      prisma.referral.aggregate({
        where: { referrerId: req.user!.userId, isPaid: true },
        _sum: { bonusAmount: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        referralCode: user?.referralCode,
        stats: {
          totalReferrals,
          paidReferrals,
          pendingReferrals: totalReferrals - paidReferrals,
          totalEarned: totalEarned._sum.bonusAmount ?? 0,
        },
      },
    });
  })
);

// ─── REFERRAL HISTORY ───────────────────────────────────

router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const referrals = await prisma.referral.findMany({
      where: { referrerId: req.user!.userId },
      include: {
        referred: {
          select: { firstName: true, lastName: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: referrals });
  })
);

// ─── APPLY REFERRAL CODE (during signup) ────────────────

router.post(
  '/apply',
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.body;
    if (!code) throw new AppError('Referral code is required', 400);

    const referrer = await prisma.user.findUnique({
      where: { referralCode: code },
    });

    if (!referrer) throw new AppError('Invalid referral code', 404);
    if (referrer.id === req.user!.userId) {
      throw new AppError('Cannot use your own referral code', 400);
    }

    // Check if already referred
    const existing = await prisma.referral.findFirst({
      where: { referredId: req.user!.userId },
    });
    if (existing) throw new AppError('You have already used a referral code', 409);

    await prisma.referral.create({
      data: {
        referrerId: referrer.id,
        referredId: req.user!.userId,
        bonusAmount: 200,
      },
    });

    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { referredBy: referrer.id },
    });

    res.json({ success: true, message: 'Referral code applied' });
  })
);

export default router;
