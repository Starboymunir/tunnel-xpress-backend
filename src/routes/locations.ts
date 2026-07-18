import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { savedLocationSchema, updateLocationSchema } from '../schemas';

const router = Router();

router.use(authenticate);

// ─── LIST SAVED LOCATIONS ───────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const locations = await prisma.savedLocation.findMany({
      where: { userId: req.user!.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({ success: true, data: locations });
  })
);

// ─── ADD SAVED LOCATION ─────────────────────────────────

router.post(
  '/',
  validate(savedLocationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { label, address, landmark, lat, lng, isDefault } = req.body;

    // If setting as default, unset existing defaults
    if (isDefault) {
      await prisma.savedLocation.updateMany({
        where: { userId: req.user!.userId },
        data: { isDefault: false },
      });
    }

    const location = await prisma.savedLocation.create({
      data: {
        userId: req.user!.userId,
        label,
        address,
        landmark,
        lat,
        lng,
        isDefault: isDefault ?? false,
      },
    });

    res.status(201).json({ success: true, data: location });
  })
);

// ─── UPDATE SAVED LOCATION ──────────────────────────────

router.patch(
  '/:id',
  validate(updateLocationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.savedLocation.findFirst({
      where: { id: req.params.id as string, userId: req.user!.userId },
    });

    if (!existing) throw new AppError('Location not found', 404);

    if (req.body.isDefault) {
      await prisma.savedLocation.updateMany({
        where: { userId: req.user!.userId },
        data: { isDefault: false },
      });
    }

    const location = await prisma.savedLocation.update({
      where: { id: req.params.id as string },
      data: req.body,
    });

    res.json({ success: true, data: location });
  })
);

// ─── DELETE SAVED LOCATION ──────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.savedLocation.findFirst({
      where: { id: req.params.id as string, userId: req.user!.userId },
    });

    if (!existing) throw new AppError('Location not found', 404);

    await prisma.savedLocation.delete({ where: { id: req.params.id as string } });

    res.json({ success: true, message: 'Location deleted' });
  })
);

export default router;
