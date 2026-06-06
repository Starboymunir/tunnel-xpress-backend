import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate, validateQuery } from '../middleware/validate';
import { createDeliverySchema, rateDeliverySchema, calculateFeeSchema } from '../schemas';
import { generateOrderTag } from '../lib/generators';
import { calculateDeliveryFee, estimateDeliveryTime, haversineDistance } from '../lib/pricing';
import { emitDeliveryMessage } from '../socket';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

// ─── CALCULATE DELIVERY FEE ─────────────────────────────

router.post(
  '/calculate-fee',
  validate(calculateFeeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { pickupLat, pickupLng, dropoffLat, dropoffLng, riderType } = req.body;

    const distanceKm = haversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);

    // Apply rider type multiplier
    const riderMultiplier = riderType === 'VAN' ? 1.8 : riderType === 'CAR' ? 1.4 : 1.0;
    const fee = calculateDeliveryFee(distanceKm, riderMultiplier);
    const estimatedMinutes = estimateDeliveryTime(distanceKm);

    res.json({
      success: true,
      data: {
        distanceKm: Math.round(distanceKm * 10) / 10,
        estimatedMinutes,
        ...fee,
      },
    });
  })
);

// ─── NEXT ORDER TAG (preview, before the order is created) ──
// Registered before any "/:id" route so it isn't captured as an id.

router.get(
  '/next-order-tag',
  asyncHandler(async (_req: Request, res: Response) => {
    const orderTag = await generateOrderTag();
    res.json({ success: true, data: { orderTag } });
  })
);

// ─── CREATE DELIVERY ────────────────────────────────────

router.post(
  '/',
  validate(createDeliverySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const data = req.body;
    const customerId = req.user!.userId;

    // Calculate distance & fee
    const distanceKm = haversineDistance(
      data.pickupLat, data.pickupLng,
      data.dropoffLat, data.dropoffLng
    );

    const riderMultiplier = data.riderType === 'VAN' ? 1.8 : data.riderType === 'CAR' ? 1.4 : 1.0;
    const fee = calculateDeliveryFee(distanceKm, riderMultiplier);
    const estimatedMinutes = estimateDeliveryTime(distanceKm);

    // Apply coupon if provided
    let couponId: string | undefined;
    let discountAmount = 0;

    if (data.couponCode) {
      const coupon = await prisma.coupon.findUnique({
        where: { code: data.couponCode },
      });

      if (coupon && coupon.isActive && coupon.expiresAt > new Date() && coupon.currentUses < coupon.maxUses) {
        if (fee.totalFee >= coupon.minOrderAmount) {
          couponId = coupon.id;
          if (coupon.discountPercent) {
            discountAmount = Math.round(fee.totalFee * (coupon.discountPercent / 100));
          } else if (coupon.discountFlat) {
            discountAmount = Math.min(coupon.discountFlat, fee.totalFee);
          }
          await prisma.coupon.update({
            where: { id: coupon.id },
            data: { currentUses: { increment: 1 } },
          });
        }
      }
    }

    const orderTag = await generateOrderTag();

    const delivery = await prisma.delivery.create({
      data: {
        orderTag,
        customerId,
        status: 'PENDING_PAYMENT',
        pickupAddress: data.pickupAddress,
        pickupLat: data.pickupLat,
        pickupLng: data.pickupLng,
        pickupContactName: data.pickupContactName,
        pickupContactPhone: data.pickupContactPhone,
        pickupNote: data.pickupNote,
        dropoffAddress: data.dropoffAddress,
        dropoffLat: data.dropoffLat,
        dropoffLng: data.dropoffLng,
        dropoffContactName: data.dropoffContactName,
        dropoffContactPhone: data.dropoffContactPhone,
        dropoffNote: data.dropoffNote,
        packageName: data.packageName,
        packageDescription: data.packageDescription,
        packageImageUrl: data.packageImageUrl,
        riderType: data.riderType,
        specialInstructions: data.specialInstructions,
        distanceKm: Math.round(distanceKm * 10) / 10,
        baseFee: fee.baseFee,
        perKmFee: fee.perKmFee,
        surgeMultiplier: fee.surgeMultiplier,
        totalFee: fee.totalFee - discountAmount,
        couponId,
        discountAmount,
        estimatedMinutes,
      },
    });

    res.status(201).json({
      success: true,
      data: delivery,
    });
  })
);

// ─── LIST MY DELIVERIES ─────────────────────────────────

const listQuerySchema = z.object({
  status: z.string().optional(),
  page: z.string().default('1').transform(Number),
  limit: z.string().default('20').transform(Number),
});

router.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { status, page, limit } = req.query as any;

    const where: any = { customerId: req.user!.userId };
    if (status) where.status = status;

    const [deliveries, total] = await Promise.all([
      prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          rider: {
            select: {
              id: true,
              vehicleType: true,
              avgRating: true,
              user: { select: { firstName: true, lastName: true, avatarUrl: true, phone: true } },
            },
          },
          rating: { select: { score: true } },
        },
      }),
      prisma.delivery.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        deliveries,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  })
);

// ─── GET DELIVERY DETAILS ───────────────────────────────

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const delivery = await prisma.delivery.findUnique({
      where: { id: req.params.id as string },
      include: {
        rider: {
          select: {
            id: true,
            vehicleType: true,
            plateNumber: true,
            avgRating: true,
            totalDeliveries: true,
            currentLat: true,
            currentLng: true,
            user: { select: { firstName: true, lastName: true, avatarUrl: true, phone: true } },
          },
        },
        payment: { select: { id: true, status: true, method: true, amount: true } },
        rating: true,
        coupon: { select: { code: true, discountPercent: true, discountFlat: true } },
      },
    });

    if (!delivery) throw new AppError('Delivery not found', 404);
    if (delivery.customerId !== req.user!.userId && req.user!.role !== 'ADMIN') {
      throw new AppError('Not authorized', 403);
    }

    res.json({ success: true, data: delivery });
  })
);

// ─── CANCEL DELIVERY ────────────────────────────────────

router.post(
  '/:id/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const delivery = await prisma.delivery.findUnique({
      where: { id: req.params.id as string },
    });

    if (!delivery) throw new AppError('Delivery not found', 404);
    if (delivery.customerId !== req.user!.userId) {
      throw new AppError('Not authorized', 403);
    }

    const cancellable: string[] = ['DRAFT', 'PENDING_PAYMENT', 'PAID', 'FINDING_RIDER'];
    if (!cancellable.includes(delivery.status)) {
      throw new AppError('Delivery cannot be cancelled at this stage', 400);
    }

    const updated = await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    // TODO: If already paid, trigger refund
    // TODO: If rider assigned, notify rider via socket

    res.json({ success: true, data: updated });
  })
);

// ─── RATE DELIVERY ──────────────────────────────────────

router.post(
  '/:id/rate',
  validate(rateDeliverySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { score, comment } = req.body;

    const delivery = await prisma.delivery.findUnique({
      where: { id: req.params.id as string },
    });

    if (!delivery) throw new AppError('Delivery not found', 404);
    if (delivery.customerId !== req.user!.userId) {
      throw new AppError('Not authorized', 403);
    }
    if (delivery.status !== 'DELIVERED') {
      throw new AppError('Can only rate delivered orders', 400);
    }
    if (!delivery.riderId) {
      throw new AppError('No rider to rate', 400);
    }

    // Check if already rated
    const existingRating = await prisma.rating.findUnique({
      where: { deliveryId: delivery.id },
    });
    if (existingRating) throw new AppError('Already rated', 409);

    const rating = await prisma.rating.create({
      data: {
        deliveryId: delivery.id,
        raterId: req.user!.userId,
        riderId: delivery.riderId,
        score,
        comment,
      },
    });

    // Update rider average rating
    const allRatings = await prisma.rating.aggregate({
      where: { riderId: delivery.riderId },
      _avg: { score: true },
    });

    await prisma.riderProfile.update({
      where: { id: delivery.riderId },
      data: { avgRating: allRatings._avg.score ?? 0 },
    });

    res.status(201).json({ success: true, data: rating });
  })
);

// ─── GET DELIVERY TRACKING ──────────────────────────────

router.get(
  '/:id/tracking',
  asyncHandler(async (req: Request, res: Response) => {
    const delivery = await prisma.delivery.findUnique({
      where: { id: req.params.id as string },
      select: {
        id: true,
        status: true,
        pickupLat: true,
        pickupLng: true,
        pickupAddress: true,
        dropoffLat: true,
        dropoffLng: true,
        dropoffAddress: true,
        liveRiderLat: true,
        liveRiderLng: true,
        estimatedMinutes: true,
        rider: {
          select: {
            currentLat: true,
            currentLng: true,
            vehicleType: true,
            avgRating: true,
            totalDeliveries: true,
            plateNumber: true,
            user: { select: { firstName: true, lastName: true, phone: true, avatarUrl: true } },
          },
        },
      },
    });

    if (!delivery) throw new AppError('Delivery not found', 404);

    res.json({ success: true, data: delivery });
  })
);

// ─── DELIVERY CHAT (customer ↔ assigned rider) ──────────

/** Returns the sender role if the user is a party to this delivery, else null. */
async function chatRoleFor(deliveryId: string, userId: string): Promise<'CUSTOMER' | 'RIDER' | null> {
  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: { customerId: true, rider: { select: { userId: true } } },
  });
  if (!delivery) return null;
  if (delivery.customerId === userId) return 'CUSTOMER';
  if (delivery.rider?.userId === userId) return 'RIDER';
  return null;
}

router.get(
  '/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const role = await chatRoleFor(req.params.id as string, req.user!.userId);
    if (!role) throw new AppError('You are not part of this delivery', 403);

    const messages = await prisma.deliveryMessage.findMany({
      where: { deliveryId: req.params.id as string },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    res.json({ success: true, data: messages });
  })
);

router.post(
  '/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const role = await chatRoleFor(req.params.id as string, req.user!.userId);
    if (!role) throw new AppError('You are not part of this delivery', 403);

    const content = (req.body?.content ?? '').toString().trim();
    if (!content) throw new AppError('Message cannot be empty', 400);

    const message = await prisma.deliveryMessage.create({
      data: { deliveryId: req.params.id as string, senderId: req.user!.userId, senderRole: role, content },
    });

    emitDeliveryMessage(req.params.id as string, message);

    res.status(201).json({ success: true, data: message });
  })
);

export default router;
