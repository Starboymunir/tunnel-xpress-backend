import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { submitRating, ratingSummary, listReviews, RatingKind } from '../lib/ratings';

const router = Router();
router.use(authenticate);

// ─── SUBMIT A RATING (RIDER | CUSTOMER | APP) ───────────
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const type = String(req.body?.type || '').toUpperCase() as RatingKind;
    if (!['RIDER', 'CUSTOMER', 'APP'].includes(type)) throw new AppError('Invalid rating type', 400);
    const rating = await submitRating({
      kind: type,
      raterId: req.user!.userId,
      deliveryId: req.body?.deliveryId ?? null,
      score: Number(req.body?.score),
      comment: req.body?.comment,
    });
    res.status(201).json({ success: true, data: rating });
  })
);

// ─── REVIEWS + SUMMARY FOR A RIDER ──────────────────────
router.get(
  '/rider/:riderProfileId',
  asyncHandler(async (req: Request, res: Response) => {
    const where = { type: 'RIDER' as const, riderProfileId: String(req.params.riderProfileId) };
    const [summary, reviews] = await Promise.all([ratingSummary(where), listReviews(where)]);
    res.json({ success: true, data: { summary, reviews } });
  })
);

// ─── RATINGS I'VE RECEIVED (as rider and/or customer) ───
router.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const profile = await prisma.riderProfile.findUnique({ where: { userId }, select: { id: true } });

    const customerWhere = { type: 'CUSTOMER' as const, ratedUserId: userId };
    const data: any = {
      customer: { summary: await ratingSummary(customerWhere), reviews: await listReviews(customerWhere) },
    };
    if (profile) {
      const riderWhere = { type: 'RIDER' as const, riderProfileId: profile.id };
      data.rider = { summary: await ratingSummary(riderWhere), reviews: await listReviews(riderWhere) };
    }
    res.json({ success: true, data });
  })
);

// ─── WHAT I'VE ALREADY RATED FOR A DELIVERY (gate UI) ───
router.get(
  '/delivery/:deliveryId',
  asyncHandler(async (req: Request, res: Response) => {
    const mine = await prisma.rating.findMany({
      where: { deliveryId: String(req.params.deliveryId), raterId: req.user!.userId },
      select: { type: true },
    });
    res.json({ success: true, data: { rated: mine.map((m) => m.type) } });
  })
);

export default router;
