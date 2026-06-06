import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/** Resolve (or lazily create) the RiderProfile for the logged-in user. */
async function getRiderProfile(userId: string) {
  let profile = await prisma.riderProfile.findUnique({ where: { userId } });
  if (!profile) {
    // Auto-provision a profile for seeded/role=RIDER users that lack one.
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || user.role !== 'RIDER') return null;
    profile = await prisma.riderProfile.create({ data: { userId, isApproved: true, availability: 'ONLINE' } });
  }
  return profile;
}

const ORDER_SELECT = {
  id: true,
  orderTag: true,
  status: true,
  packageName: true,
  packageDescription: true,
  packageImageUrl: true,
  pickupAddress: true,
  pickupLat: true,
  pickupLng: true,
  pickupContactName: true,
  pickupContactPhone: true,
  dropoffAddress: true,
  dropoffLat: true,
  dropoffLng: true,
  dropoffContactName: true,
  dropoffContactPhone: true,
  totalFee: true,
  distanceKm: true,
  estimatedMinutes: true,
  riderType: true,
  specialInstructions: true,
  createdAt: true,
  assignedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  customer: { select: { firstName: true, lastName: true, phone: true, avatarUrl: true } },
} as const;

// ─── AVAILABLE ORDERS (awaiting a rider) ────────────────
router.get(
  '/available-orders',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const orders = await prisma.delivery.findMany({
      where: { riderId: null, status: { in: ['FINDING_RIDER', 'PAID'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: ORDER_SELECT,
    });

    res.json({ success: true, data: orders });
  })
);

// ─── MY ORDERS (assigned to this rider) ─────────────────
router.get(
  '/my-orders',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const orders = await prisma.delivery.findMany({
      where: { riderId: profile.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: ORDER_SELECT,
    });

    res.json({ success: true, data: orders });
  })
);

// ─── ACCEPT AN ORDER ────────────────────────────────────
router.post(
  '/orders/:id/accept',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const delivery = await prisma.delivery.findUnique({ where: { id: String(req.params.id) } });
    if (!delivery) throw new AppError('Order not found', 404);
    if (delivery.riderId) throw new AppError('This order has already been accepted', 409);
    if (!['FINDING_RIDER', 'PAID'].includes(delivery.status)) {
      throw new AppError('This order is not available to accept', 400);
    }

    const updated = await prisma.delivery.update({
      where: { id: delivery.id },
      data: { riderId: profile.id, status: 'RIDER_ASSIGNED', assignedAt: new Date() },
      select: ORDER_SELECT,
    });

    res.json({ success: true, data: updated });
  })
);

// ─── ADVANCE ORDER STATUS ───────────────────────────────
const NEXT_STATUS: Record<string, 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED'> = {
  RIDER_ASSIGNED: 'PICKED_UP',
  PICKED_UP: 'IN_TRANSIT',
  IN_TRANSIT: 'DELIVERED',
};

router.post(
  '/orders/:id/status',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const target = req.body?.status as string | undefined;

    const delivery = await prisma.delivery.findUnique({ where: { id: String(req.params.id) } });
    if (!delivery) throw new AppError('Order not found', 404);
    if (delivery.riderId !== profile.id) throw new AppError('This is not your order', 403);

    // Allow an explicit target if it's the valid next step, else auto-advance.
    const expected = NEXT_STATUS[delivery.status];
    if (!expected) throw new AppError('Order cannot be advanced further', 400);
    if (target && target !== expected) throw new AppError(`Next step must be ${expected}`, 400);

    const data: any = { status: expected };
    if (expected === 'PICKED_UP') data.pickedUpAt = new Date();
    if (expected === 'DELIVERED') data.deliveredAt = new Date();

    const updated = await prisma.delivery.update({
      where: { id: delivery.id },
      data,
      select: ORDER_SELECT,
    });

    if (expected === 'DELIVERED') {
      await prisma.riderProfile.update({
        where: { id: profile.id },
        data: { totalDeliveries: { increment: 1 } },
      });
    }

    res.json({ success: true, data: updated });
  })
);

export default router;
