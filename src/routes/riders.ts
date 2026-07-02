import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { submitVerificationSchema, reviewVerificationSchema, payoutAccountSchema, rateCustomerSchema } from '../schemas';
import { config } from '../config';
import { generateCode } from '../lib/generators';
import { maybeRewardReferral } from '../lib/referralReward';
import { submitRating } from '../lib/ratings';
import { emitDeliveryStatus, emitNotification, notifyAdmins } from '../socket';

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
      where: {
        riderId: null,
        status: { in: ['FINDING_RIDER', 'PAID'] },
        NOT: { declinedRiderIds: { has: profile.id } },
      },
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
      data: {
        riderId: profile.id,
        status: 'RIDER_ASSIGNED',
        assignedAt: new Date(),
        // Backfill hand-off codes for orders created before codes existed.
        ...(delivery.dropoffCode ? {} : { dropoffCode: generateCode() }),
        ...(delivery.pickupCode ? {} : { pickupCode: generateCode() }),
      },
      select: ORDER_SELECT,
    });

    emitDeliveryStatus(delivery.id, 'RIDER_ASSIGNED');
    emitNotification(delivery.customerId, {
      type: 'RIDER',
      title: 'Rider Assigned',
      body: 'A rider has accepted your order and is on the way to pick it up.',
    });
    notifyAdmins({
      type: 'RIDER',
      title: 'Rider Assigned',
      body: `A rider has been assigned to Order ${delivery.orderTag}`,
      data: { deliveryId: delivery.id },
    }).catch(() => {});

    res.json({ success: true, data: updated });
  })
);

// ─── DECLINE AN ORDER ───────────────────────────────────
router.post(
  '/orders/:id/decline',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const delivery = await prisma.delivery.findUnique({ where: { id: String(req.params.id) }, select: { id: true, declinedRiderIds: true } });
    if (!delivery) throw new AppError('Order not found', 404);

    if (!delivery.declinedRiderIds.includes(profile.id)) {
      await prisma.delivery.update({
        where: { id: delivery.id },
        data: { declinedRiderIds: { push: profile.id } },
      });
    }
    res.json({ success: true, data: { declined: true } });
  })
);

// Rider keeps this share of each delivery's total fee.
const COMMISSION_RATE = 0.8;

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
      // Record the rider's commission for this trip (idempotent on deliveryId).
      const amount = Math.round((delivery.totalFee ?? 0) * COMMISSION_RATE);
      await prisma.riderEarning.upsert({
        where: { deliveryId: delivery.id },
        create: { riderProfileId: profile.id, deliveryId: delivery.id, amount, distanceKm: delivery.distanceKm ?? 0 },
        update: {},
      });
      // Reward the customer's referrer if this was their first completed delivery.
      await maybeRewardReferral(delivery.customerId);
    }

    emitDeliveryStatus(delivery.id, expected);
    const notif: Record<string, { title: string; body: string }> = {
      PICKED_UP: { title: 'Package Picked Up', body: 'Your package has been picked up and is on its way.' },
      IN_TRANSIT: { title: 'In Transit', body: 'Your package is now in transit.' },
      DELIVERED: { title: 'Delivered', body: 'Your package has been delivered successfully.' },
    };
    if (notif[expected]) emitNotification(delivery.customerId, { type: 'ORDER', ...notif[expected] });

    res.json({ success: true, data: updated });
  })
);

// ─── RIDER RATES THE CUSTOMER ───────────────────────────
router.post(
  '/orders/:id/rate-customer',
  validate(rateCustomerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { score, comment } = req.body as { score: number; comment?: string };
    // Rider rating the customer — unified rating pipeline (auth, de-dupe, averages).
    const rating = await submitRating({
      kind: 'CUSTOMER',
      raterId: req.user!.userId,
      deliveryId: String(req.params.id),
      score,
      comment,
    });

    res.json({ success: true, data: { rated: true, id: rating.id } });
  })
);

// ─── VERIFY DROPOFF CODE → COMPLETE DELIVERY ────────────
router.post(
  '/orders/:id/verify-code',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const code = String(req.body?.code || '').trim();
    const stage = req.body?.stage === 'pickup' ? 'pickup' : 'dropoff';
    const delivery = await prisma.delivery.findUnique({ where: { id: String(req.params.id) } });
    if (!delivery) throw new AppError('Order not found', 404);
    if (delivery.riderId !== profile.id) throw new AppError('This is not your order', 403);

    // ── Pickup leg: verify the pickup code → PICKED_UP ──
    if (stage === 'pickup') {
      if (['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].includes(delivery.status)) {
        return res.json({ success: true, data: { id: delivery.id, status: delivery.status } });
      }
      if (!delivery.pickupCode || code !== delivery.pickupCode) {
        throw new AppError('That code is incorrect. Ask the customer to confirm it.', 400);
      }
      const updated = await prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'PICKED_UP', pickedUpAt: new Date() },
        select: ORDER_SELECT,
      });
      emitDeliveryStatus(delivery.id, 'PICKED_UP');
      emitNotification(delivery.customerId, { type: 'ORDER', title: 'Package Picked Up', body: 'Your package has been picked up and is on its way.' });
      return res.json({ success: true, data: updated });
    }

    // ── Dropoff leg: verify the dropoff code → DELIVERED ──
    if (delivery.status === 'DELIVERED') {
      return res.json({ success: true, data: { id: delivery.id, status: 'DELIVERED' } });
    }
    if (!delivery.dropoffCode || code !== delivery.dropoffCode) {
      throw new AppError('That code is incorrect. Ask the customer to confirm it.', 400);
    }

    const updated = await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'DELIVERED', deliveredAt: new Date(), pickedUpAt: delivery.pickedUpAt ?? new Date() },
      select: ORDER_SELECT,
    });

    await prisma.riderProfile.update({ where: { id: profile.id }, data: { totalDeliveries: { increment: 1 } } });
    const amount = Math.round((delivery.totalFee ?? 0) * COMMISSION_RATE);
    await prisma.riderEarning.upsert({
      where: { deliveryId: delivery.id },
      create: { riderProfileId: profile.id, deliveryId: delivery.id, amount, distanceKm: delivery.distanceKm ?? 0 },
      update: {},
    });
    await maybeRewardReferral(delivery.customerId);

    emitDeliveryStatus(delivery.id, 'DELIVERED');
    emitNotification(delivery.customerId, { type: 'ORDER', title: 'Delivered', body: 'Your package has been delivered successfully.' });

    res.json({ success: true, data: updated });
  })
);

// ─── KYC VERIFICATION ───────────────────────────────────

// Current rider's verification status + submitted bundle (if any).
router.get(
  '/verification',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const verification = await prisma.riderVerification.findUnique({
      where: { riderProfileId: profile.id },
    });

    res.json({
      success: true,
      data: { status: profile.verificationStatus, verification },
    });
  })
);

// Submit (or re-submit) the KYC bundle → status PENDING.
router.post(
  '/verification',
  validate(submitVerificationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const body = req.body as Record<string, unknown>;

    const verification = await prisma.riderVerification.upsert({
      where: { riderProfileId: profile.id },
      create: { riderProfileId: profile.id, status: 'PENDING', submittedAt: new Date(), ...body } as any,
      update: { status: 'PENDING', rejectionReason: null, reviewedAt: null, submittedAt: new Date(), ...body } as any,
    });

    await prisma.riderProfile.update({
      where: { id: profile.id },
      data: {
        verificationStatus: 'PENDING',
        isApproved: false, // can't take orders until reviewed
        // Keep the rider's working fields in sync with what they submitted.
        plateNumber: (body.plateNumber as string) || profile.plateNumber,
        licenseNumber: (body.permitNumber as string) || profile.licenseNumber,
      },
    });

    res.status(201).json({ success: true, data: { status: 'PENDING', verification } });
  })
);

// Review a rider's submission (ADMIN; also allowed self-review in non-production for testing).
router.post(
  '/verification/review',
  validate(reviewVerificationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const isAdmin = req.user!.role === 'ADMIN';
    const allowSelf = config.env !== 'production';
    if (!isAdmin && !allowSelf) throw new AppError('Insufficient permissions', 403);

    const { decision, reason } = req.body as { decision: 'approve' | 'reject'; reason?: string };
    const targetProfileId = (req.body.riderProfileId as string | undefined) || (await getRiderProfile(req.user!.userId))?.id;
    if (!targetProfileId) throw new AppError('Rider profile not found', 404);

    const verification = await prisma.riderVerification.findUnique({ where: { riderProfileId: targetProfileId } });
    if (!verification) throw new AppError('No verification submitted', 404);

    const approved = decision === 'approve';
    const updated = await prisma.riderVerification.update({
      where: { riderProfileId: targetProfileId },
      data: {
        status: approved ? 'APPROVED' : 'REJECTED',
        rejectionReason: approved ? null : reason || 'Your data are not consistent with data on ID, please review and re-upload.',
        reviewedAt: new Date(),
      },
    });

    const rider = await prisma.riderProfile.update({
      where: { id: targetProfileId },
      data: { verificationStatus: approved ? 'APPROVED' : 'REJECTED', isApproved: approved },
      select: { userId: true },
    });

    emitNotification(rider.userId, {
      type: 'RIDER',
      title: approved ? 'Verification Approved' : 'Verification Rejected',
      body: approved
        ? 'Your account has been verified. You can now go online.'
        : updated.rejectionReason || 'Your verification was rejected. Please review and re-upload.',
    });

    res.json({ success: true, data: { status: updated.status, verification: updated } });
  })
);

// ─── RIDER SUMMARY ──────────────────────────────────────
router.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);
    res.json({
      success: true,
      data: {
        online: profile.availability === 'ONLINE',
        availability: profile.availability,
        isApproved: profile.isApproved,
        verificationStatus: profile.verificationStatus,
        totalDeliveries: profile.totalDeliveries,
        avgRating: profile.avgRating,
        vehicleType: profile.vehicleType,
        plateNumber: profile.plateNumber,
        vehicleColor: profile.vehicleColor,
      },
    });
  })
);

// ─── UPDATE RIDER VEHICLE / PROFILE ─────────────────────
router.patch(
  '/profile',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const data: { vehicleType?: 'BIKE' | 'CAR' | 'VAN'; plateNumber?: string; vehicleColor?: string } = {};
    const vt = req.body?.vehicleType;
    if (vt === 'BIKE' || vt === 'CAR' || vt === 'VAN') data.vehicleType = vt;
    if (typeof req.body?.plateNumber === 'string') data.plateNumber = req.body.plateNumber.trim().toUpperCase();
    if (typeof req.body?.vehicleColor === 'string') data.vehicleColor = req.body.vehicleColor.trim();

    const updated = await prisma.riderProfile.update({
      where: { id: profile.id },
      data,
      select: { vehicleType: true, plateNumber: true, vehicleColor: true },
    });
    res.json({ success: true, data: updated });
  })
);

// ─── AVAILABILITY (online toggle) ───────────────────────
router.patch(
  '/availability',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);
    const online = req.body?.online === true || req.body?.availability === 'ONLINE';
    const updated = await prisma.riderProfile.update({
      where: { id: profile.id },
      data: { availability: online ? 'ONLINE' : 'OFFLINE' },
      select: { availability: true },
    });
    res.json({ success: true, data: { availability: updated.availability, online: updated.availability === 'ONLINE' } });
  })
);

// ─── EARNINGS ───────────────────────────────────────────
// range=pending → unpaid ledger + breakdown; range=paid → settled payout history.
router.get(
  '/earnings',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const range = String(req.query.range || 'pending');
    const account = await prisma.riderPayoutAccount.findUnique({ where: { riderProfileId: profile.id } });
    const hasPayoutDetails = !!account && account.status === 'VERIFIED';

    if (range === 'paid') {
      // The design has no manual "request payout" button — payouts are scheduled.
      // Simulate the schedule: once payout details are verified, settle any
      // pending earnings into a payout so they appear in the paid history.
      if (hasPayoutDetails && account) {
        const pending = await prisma.riderEarning.findMany({
          where: { riderProfileId: profile.id, status: 'PENDING' },
          select: { id: true, amount: true },
        });
        if (pending.length > 0) {
          const amount = pending.reduce((s, e) => s + e.amount, 0);
          const reference = `PO-${Date.now().toString(36).toUpperCase()}`;
          const periodMonth = new Date().toISOString().slice(0, 7);
          const payout = await prisma.payout.create({
            data: { riderProfileId: profile.id, reference, amount, status: 'PAID', payoutAccountId: account.id, periodMonth, paidAt: new Date() },
          });
          await prisma.riderEarning.updateMany({
            where: { riderProfileId: profile.id, status: 'PENDING' },
            data: { status: 'PAID', payoutId: payout.id, paidAt: new Date() },
          });
          emitNotification(req.user!.userId, {
            type: 'PAYMENT',
            title: 'Payout sent',
            body: `₦${amount.toLocaleString()} has been paid to your ${account.bankName} account (${account.last4}).`,
          });
        }
      }

      const payouts = await prisma.payout.findMany({
        where: { riderProfileId: profile.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const totalPaid = payouts.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
      // Group payouts by month label.
      const groups: Record<string, { month: string; total: number; payouts: any[] }> = {};
      for (const p of payouts) {
        const key = p.periodMonth || p.createdAt.toISOString().slice(0, 7);
        if (!groups[key]) groups[key] = { month: key, total: 0, payouts: [] };
        groups[key].total += p.amount;
        groups[key].payouts.push({ id: p.id, date: p.createdAt, reference: p.reference, amount: p.amount, status: p.status });
      }
      return res.json({ success: true, data: { totalPaid, history: Object.values(groups), hasPayoutDetails } });
    }

    const earnings = await prisma.riderEarning.findMany({
      where: { riderProfileId: profile.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { delivery: { select: { orderTag: true, packageName: true, pickupAddress: true, dropoffAddress: true } } },
    });
    const totalPending = earnings.reduce((s, e) => s + e.amount, 0);
    const breakdown = earnings.map((e) => ({
      id: e.id,
      deliveryId: e.deliveryId,
      orderTag: e.delivery.orderTag,
      packageName: e.delivery.packageName,
      pickupAddress: e.delivery.pickupAddress,
      dropoffAddress: e.delivery.dropoffAddress,
      distanceKm: e.distanceKm,
      amount: e.amount,
      date: e.createdAt,
    }));

    // Today-vs-yesterday delta for the "up/down by X% from yesterday" pill.
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const startYest = new Date(startToday); startYest.setDate(startYest.getDate() - 1);
    const [todayAgg, yestAgg] = await Promise.all([
      prisma.riderEarning.aggregate({ where: { riderProfileId: profile.id, createdAt: { gte: startToday } }, _sum: { amount: true } }),
      prisma.riderEarning.aggregate({ where: { riderProfileId: profile.id, createdAt: { gte: startYest, lt: startToday } }, _sum: { amount: true } }),
    ]);
    const todaySum = todayAgg._sum.amount ?? 0;
    const yestSum = yestAgg._sum.amount ?? 0;
    const deltaPct = yestSum > 0 ? Math.round(((todaySum - yestSum) / yestSum) * 100) : null;

    res.json({ success: true, data: { totalPending, breakdown, hasPayoutDetails, deltaPct } });
  })
);

// ─── REQUEST A PAYOUT (settle pending earnings) ─────────
router.post(
  '/payouts/request',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const account = await prisma.riderPayoutAccount.findUnique({ where: { riderProfileId: profile.id } });
    if (!account || account.status !== 'VERIFIED') {
      throw new AppError('Add a verified payout account before requesting a payout', 400);
    }

    const pending = await prisma.riderEarning.findMany({
      where: { riderProfileId: profile.id, status: 'PENDING' },
      select: { id: true, amount: true },
    });
    if (pending.length === 0) throw new AppError('You have no pending earnings to pay out', 400);

    const amount = pending.reduce((s, e) => s + e.amount, 0);
    const reference = `PO-${Date.now().toString(36).toUpperCase()}`;
    const periodMonth = new Date().toISOString().slice(0, 7);

    // In production this would create a Paystack Transfer (status PROCESSING) and
    // settle on the transfer.success webhook. Here we mark it paid immediately.
    const payout = await prisma.payout.create({
      data: { riderProfileId: profile.id, reference, amount, status: 'PAID', payoutAccountId: account.id, periodMonth, paidAt: new Date() },
    });
    await prisma.riderEarning.updateMany({
      where: { riderProfileId: profile.id, status: 'PENDING' },
      data: { status: 'PAID', payoutId: payout.id, paidAt: new Date() },
    });

    emitNotification(req.user!.userId, {
      type: 'PAYMENT',
      title: 'Payout sent',
      body: `₦${amount.toLocaleString()} has been paid to your ${account.bankName} account (${account.last4}).`,
    });

    res.json({ success: true, data: { reference, amount, status: payout.status } });
  })
);

// ─── PAYOUT ACCOUNT ─────────────────────────────────────
router.get(
  '/payout-account',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);
    const account = await prisma.riderPayoutAccount.findUnique({ where: { riderProfileId: profile.id } });
    res.json({
      success: true,
      data: account
        ? { bankName: account.bankName, bankCode: account.bankCode, accountName: account.accountName, last4: account.last4, status: account.status }
        : null,
    });
  })
);

// Save/verify a payout (NUBAN) account. The resolved account name must match
// the rider's KYC full name, otherwise it's rejected (422).
router.post(
  '/payout-account',
  validate(payoutAccountSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await getRiderProfile(req.user!.userId);
    if (!profile) throw new AppError('Not a rider account', 403);

    const { accountNumber, bankCode, bankName, accountName } = req.body as {
      accountNumber: string; bankCode: string; bankName: string; accountName: string;
    };

    // Compare against the KYC name when available.
    const verification = await prisma.riderVerification.findUnique({ where: { riderProfileId: profile.id }, select: { fullName: true } });
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
    const kyc = verification?.fullName ? norm(verification.fullName) : '';
    const resolved = norm(accountName);
    const nameMatches = !kyc || kyc.split('').sort().join('') === resolved.split('').sort().join('') ||
      resolved.includes(kyc) || kyc.includes(resolved);

    if (!nameMatches) {
      return res.status(422).json({ success: false, error: 'name_mismatch', message: 'The account name does not match your verified identity.' });
    }

    const last4 = accountNumber.slice(-4);
    const account = await prisma.riderPayoutAccount.upsert({
      where: { riderProfileId: profile.id },
      create: { riderProfileId: profile.id, accountNumber, bankCode, bankName, accountName, last4, status: 'VERIFIED' },
      update: { accountNumber, bankCode, bankName, accountName, last4, status: 'VERIFIED' },
    });
    res.json({ success: true, data: { status: account.status, bankName: account.bankName, accountName: account.accountName, last4: account.last4 } });
  })
);

export default router;
