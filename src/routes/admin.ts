import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate, requireRole } from '../middleware/auth';
import { emitDeliveryStatus, emitNotification, emitSupportMessage, isUserInRoom } from '../socket';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

// Rider's share of an order; the platform keeps the rest.
const COMMISSION_RATE = 0.8;

const ACTIVE_STATUSES = ['RIDER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] as const;

function dayStart(offsetDays = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/** % change between today's and yesterday's counts (null when yesterday is 0). */
function delta(today: number, yesterday: number): number | null {
  if (!yesterday) return null;
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

async function countByDay(where: object): Promise<{ today: number; yesterday: number }> {
  const [today, yesterday] = await Promise.all([
    prisma.delivery.count({ where: { ...where, createdAt: { gte: dayStart() } } }),
    prisma.delivery.count({ where: { ...where, createdAt: { gte: dayStart(-1), lt: dayStart() } } }),
  ]);
  return { today, yesterday };
}

// ─── PERIOD BUCKETS ──────────────────────────────────────
// Stat cards let the admin switch Daily / Weekly / Monthly / All-time.
// Each bucket carries its value and a % delta vs the preceding window.
type StatVal = { value: number; deltaPct: number | null };
export type StatBuckets = { daily: StatVal; weekly: StatVal; monthly: StatVal; all: StatVal };

/**
 * Bucket rows (each with a timestamp and an optional amount) into
 * daily/weekly/monthly windows with deltas. `rows` must cover at least the
 * last 60 days; `allValue` is the all-time value (count or sum).
 */
function bucketize(rows: { at: Date; amount?: number }[], allValue: number): StatBuckets {
  const windows: [keyof StatBuckets, Date, Date, Date][] = [
    ['daily', dayStart(0), dayStart(-1), dayStart(0)],
    ['weekly', dayStart(-6), dayStart(-13), dayStart(-6)],
    ['monthly', dayStart(-29), dayStart(-59), dayStart(-29)],
  ];
  const out = {} as StatBuckets;
  for (const [key, from, prevFrom, prevTo] of windows) {
    let cur = 0;
    let prev = 0;
    for (const r of rows) {
      const v = r.amount ?? 1;
      if (r.at >= from) cur += v;
      else if (r.at >= prevFrom && r.at < prevTo) prev += v;
    }
    out[key] = { value: Math.round(cur), deltaPct: delta(cur, prev) };
  }
  out.all = { value: Math.round(allValue), deltaPct: null };
  return out;
}

const SIXTY_DAYS_AGO = () => dayStart(-59);

const fullName = (u: { firstName: string | null; lastName: string | null } | null | undefined) =>
  [u?.firstName, u?.lastName].filter(Boolean).join(' ') || '—';

// ─── OVERVIEW (Home) ─────────────────────────────────────
router.get(
  '/overview',
  asyncHandler(async (_req: Request, res: Response) => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const [requests, pending, availableRiders, active, delayed, live] = await Promise.all([
      prisma.delivery.findMany({
        where: { status: 'FINDING_RIDER', riderId: null },
        orderBy: { createdAt: 'asc' },
        take: 10,
        include: { customer: { select: { firstName: true, lastName: true } } },
      }),
      prisma.delivery.count({ where: { status: 'FINDING_RIDER' } }),
      prisma.riderProfile.count({ where: { availability: 'ONLINE', isApproved: true } }),
      prisma.delivery.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
      prisma.delivery.count({ where: { status: 'FINDING_RIDER', createdAt: { lt: tenMinAgo } } }),
      prisma.delivery.findMany({
        where: { status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { assignedAt: 'desc' },
        take: 10,
        include: {
          customer: { select: { firstName: true, lastName: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true } } } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        riderRequests: requests.map((d) => ({
          deliveryId: d.id,
          customer: fullName(d.customer),
          pickup: d.pickupAddress,
          dropoff: d.dropoffAddress,
          distanceKm: d.distanceKm,
          requestedAt: d.createdAt,
          priority: d.createdAt < tenMinAgo ? 'Urgent' : 'Waiting',
        })),
        counts: { pending, available: availableRiders, active, delayed },
        liveDeliveries: live.map((d) => ({
          id: d.id,
          orderTag: d.orderTag,
          orderName: d.packageName,
          customer: fullName(d.customer),
          rider: fullName(d.rider?.user),
          pickup: d.pickupAddress,
          dropoff: d.dropoffAddress,
          status: d.status,
          etaMinutes: d.estimatedMinutes,
        })),
      },
    });
  })
);

// ─── AVAILABLE RIDERS (assign flow) ──────────────────────
router.get(
  '/available-riders',
  asyncHandler(async (req: Request, res: Response) => {
    const deliveryId = String(req.query.deliveryId || '');
    const delivery = deliveryId
      ? await prisma.delivery.findUnique({ where: { id: deliveryId } })
      : null;

    const riders = await prisma.riderProfile.findMany({
      where: { isApproved: true },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { availability: 'asc' }, // ONLINE < OFFLINE < BUSY alphabetically? keep simple, re-sort below
      take: 50,
    });

    const withDistance = riders.map((r) => {
      let distanceKm: number | null = null;
      if (delivery && r.currentLat != null && r.currentLng != null) {
        const dLat = ((r.currentLat - delivery.pickupLat) * Math.PI) / 180;
        const dLng = ((r.currentLng - delivery.pickupLng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((delivery.pickupLat * Math.PI) / 180) *
            Math.cos((r.currentLat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
        distanceKm = Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
      }
      return {
        riderId: r.id,
        name: fullName(r.user),
        distanceKm,
        availability: r.availability,
        rating: r.avgRating,
        ratingCount: r.ratingCount,
      };
    });

    // Online riders first, then nearest first.
    withDistance.sort((a, b) => {
      const availA = a.availability === 'ONLINE' ? 0 : 1;
      const availB = b.availability === 'ONLINE' ? 0 : 1;
      if (availA !== availB) return availA - availB;
      return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
    });

    res.json({ success: true, data: withDistance });
  })
);

// ─── ASSIGN RIDER ────────────────────────────────────────
router.post(
  '/assign',
  asyncHandler(async (req: Request, res: Response) => {
    const { deliveryId, riderId } = req.body as { deliveryId?: string; riderId?: string };
    if (!deliveryId || !riderId) throw new AppError('deliveryId and riderId are required', 400);

    const [delivery, rider] = await Promise.all([
      prisma.delivery.findUnique({ where: { id: deliveryId } }),
      prisma.riderProfile.findUnique({ where: { id: riderId }, include: { user: true } }),
    ]);
    if (!delivery) throw new AppError('Order not found', 404);
    if (!rider) throw new AppError('Rider not found', 404);
    if (delivery.riderId) throw new AppError('This order already has a rider', 409);
    if (!['FINDING_RIDER', 'PAID'].includes(delivery.status)) {
      throw new AppError('This order is not awaiting a rider', 400);
    }

    const gen = () => String(Math.floor(1000 + Math.random() * 9000));
    const updated = await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        riderId: rider.id,
        status: 'RIDER_ASSIGNED',
        assignedAt: new Date(),
        ...(delivery.dropoffCode ? {} : { dropoffCode: gen() }),
        ...(delivery.pickupCode ? {} : { pickupCode: gen() }),
      },
    });

    emitDeliveryStatus(delivery.id, 'RIDER_ASSIGNED');
    emitNotification(delivery.customerId, {
      type: 'RIDER',
      title: 'Rider Assigned',
      body: `${fullName(rider.user)} has been assigned to your order and is on the way.`,
    });
    emitNotification(rider.userId, {
      type: 'ORDER',
      title: 'New delivery assigned',
      body: `${delivery.packageName || 'A package'} · ${delivery.pickupAddress} → ${delivery.dropoffAddress}`,
      data: { deliveryId: delivery.id },
    });

    res.json({ success: true, data: { id: updated.id, status: updated.status, rider: fullName(rider.user) } });
  })
);

// ─── ORDERS ──────────────────────────────────────────────
router.get(
  '/orders',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, active, completed, canceled, recent, list] = await Promise.all([
      prisma.delivery.count(),
      prisma.delivery.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
      prisma.delivery.count({ where: { status: 'DELIVERED' } }),
      prisma.delivery.count({ where: { status: { in: ['CANCELLED', 'FAILED'] } } }),
      prisma.delivery.findMany({
        where: { createdAt: { gte: SIXTY_DAYS_AGO() }, status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } },
        select: { createdAt: true, status: true },
      }),
      prisma.delivery.findMany({
        where: { status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          customer: { select: { firstName: true, lastName: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true } } } },
        },
      }),
    ]);

    const rows = (filter: (s: string) => boolean) =>
      recent.filter((d) => filter(d.status)).map((d) => ({ at: d.createdAt }));

    res.json({
      success: true,
      data: {
        stats: {
          total: bucketize(rows(() => true), total),
          active: bucketize(rows((s) => (ACTIVE_STATUSES as readonly string[]).includes(s)), active),
          completed: bucketize(rows((s) => s === 'DELIVERED'), completed),
          canceled: bucketize(rows((s) => s === 'CANCELLED' || s === 'FAILED'), canceled),
        },
        orders: list.map((d) => ({
          id: d.id,
          orderTag: d.orderTag,
          orderName: d.packageName,
          customer: fullName(d.customer),
          rider: fullName(d.rider?.user),
          pickup: d.pickupAddress,
          dropoff: d.dropoffAddress,
          price: d.totalFee,
          status: d.status,
          createdAt: d.createdAt,
          etaMinutes: d.estimatedMinutes,
        })),
      },
    });
  })
);

// ─── CUSTOMERS ───────────────────────────────────────────
router.get(
  '/customers',
  asyncHandler(async (_req: Request, res: Response) => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [total, signups, activeIds, customers] = await Promise.all([
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.user.findMany({
        where: { role: 'CUSTOMER', createdAt: { gte: SIXTY_DAYS_AGO() } },
        select: { createdAt: true },
      }),
      prisma.delivery.groupBy({
        by: ['customerId'],
        where: { createdAt: { gte: monthAgo } },
      }),
      prisma.user.findMany({
        where: { role: 'CUSTOMER' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          deliveries: {
            where: { status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } },
            select: { totalFee: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    ]);

    const active = activeIds.length;
    res.json({
      success: true,
      data: {
        stats: {
          total: bucketize(signups.map((u) => ({ at: u.createdAt })), total),
          active,
          inactive: Math.max(0, total - active),
        },
        customers: customers.map((c) => ({
          id: c.id,
          name: fullName(c),
          email: c.email,
          phone: c.phone,
          totalOrders: c.deliveries.length,
          totalSpend: c.deliveries.reduce((s, d) => s + (d.totalFee || 0), 0),
          lastOrderAt: c.deliveries[0]?.createdAt ?? null,
        })),
      },
    });
  })
);

// ─── RIDERS ──────────────────────────────────────────────
router.get(
  '/riders',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, signups, online, offline, busy, riders] = await Promise.all([
      prisma.riderProfile.count(),
      prisma.riderProfile.findMany({ where: { createdAt: { gte: SIXTY_DAYS_AGO() } }, select: { createdAt: true } }),
      prisma.riderProfile.count({ where: { availability: 'ONLINE' } }),
      prisma.riderProfile.count({ where: { availability: 'OFFLINE' } }),
      prisma.riderProfile.count({ where: { availability: 'BUSY' } }),
      prisma.riderProfile.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          user: { select: { firstName: true, lastName: true, email: true, phone: true, isActive: true } },
          earnings: { select: { amount: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        stats: {
          total: bucketize(signups.map((r) => ({ at: r.createdAt })), total),
          online,
          offline,
          busy,
        },
        riders: riders.map((r) => ({
          id: r.id,
          name: fullName(r.user),
          email: r.user.email,
          phone: r.user.phone,
          availability: r.availability,
          totalDeliveries: r.totalDeliveries,
          rating: r.avgRating,
          earnings: r.earnings.reduce((s, e) => s + e.amount, 0),
          verified: r.verificationStatus === 'APPROVED' || r.isApproved,
          active: r.user.isActive,
        })),
      },
    });
  })
);

// ─── RIDER MANAGEMENT (PDR: approve / suspend) ───────────
router.patch(
  '/riders/:id/approve',
  asyncHandler(async (req: Request, res: Response) => {
    const rider = await prisma.riderProfile.findUnique({ where: { id: String(req.params.id) } });
    if (!rider) throw new AppError('Rider not found', 404);

    await prisma.riderProfile.update({
      where: { id: rider.id },
      data: { isApproved: true, verificationStatus: 'APPROVED' },
    });
    emitNotification(rider.userId, {
      type: 'SYSTEM',
      title: 'Verification approved',
      body: 'Your rider account has been approved. Go online to start receiving deliveries!',
    });
    res.json({ success: true, data: { id: rider.id, verified: true } });
  })
);

router.patch(
  '/riders/:id/suspend',
  asyncHandler(async (req: Request, res: Response) => {
    const suspend = req.body?.suspend !== false; // default: suspend
    const rider = await prisma.riderProfile.findUnique({ where: { id: String(req.params.id) } });
    if (!rider) throw new AppError('Rider not found', 404);

    await prisma.$transaction([
      prisma.user.update({ where: { id: rider.userId }, data: { isActive: !suspend } }),
      // A suspended rider must not appear available for jobs.
      ...(suspend
        ? [prisma.riderProfile.update({ where: { id: rider.id }, data: { availability: 'OFFLINE' } })]
        : []),
    ]);
    emitNotification(rider.userId, {
      type: 'SYSTEM',
      title: suspend ? 'Account suspended' : 'Account reactivated',
      body: suspend
        ? 'Your rider account has been suspended. Contact support for more information.'
        : 'Your rider account has been reactivated. Welcome back!',
    });
    res.json({ success: true, data: { id: rider.id, active: !suspend } });
  })
);

// ─── ORDER INTERVENTION (PDR: resolve issues) ────────────
router.patch(
  '/orders/:id/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const delivery = await prisma.delivery.findUnique({
      where: { id: String(req.params.id) },
      include: { rider: { select: { userId: true } } },
    });
    if (!delivery) throw new AppError('Order not found', 404);
    if (['DELIVERED', 'CANCELLED', 'FAILED'].includes(delivery.status)) {
      throw new AppError('This order can no longer be canceled', 400);
    }

    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    emitDeliveryStatus(delivery.id, 'CANCELLED');
    emitNotification(delivery.customerId, {
      type: 'ORDER',
      title: 'Order canceled',
      body: `Your order ${delivery.orderTag} was canceled by support. Contact us if you weren't expecting this.`,
    });
    if (delivery.rider?.userId) {
      emitNotification(delivery.rider.userId, {
        type: 'ORDER',
        title: 'Order canceled',
        body: `Order ${delivery.orderTag} has been canceled by support.`,
      });
    }
    res.json({ success: true, data: { id: delivery.id, status: 'CANCELLED' } });
  })
);

// ─── REVENUE ─────────────────────────────────────────────
router.get(
  '/revenue',
  asyncHandler(async (_req: Request, res: Response) => {
    const [agg, recentDelivered, pendingEarnings, list] = await Promise.all([
      prisma.delivery.aggregate({ where: { status: 'DELIVERED' }, _sum: { totalFee: true } }),
      prisma.delivery.findMany({
        where: { status: 'DELIVERED', deliveredAt: { gte: SIXTY_DAYS_AGO() } },
        select: { deliveredAt: true, totalFee: true },
      }),
      prisma.riderEarning.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true } }),
      prisma.delivery.findMany({
        where: { status: 'DELIVERED' },
        orderBy: { deliveredAt: 'desc' },
        take: 50,
        include: {
          customer: { select: { firstName: true, lastName: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true } } } },
        },
      }),
    ]);

    const totalRevenue = agg._sum.totalFee || 0;
    const platformFees = Math.round(totalRevenue * (1 - COMMISSION_RATE));
    const revRows = recentDelivered.map((d) => ({ at: d.deliveredAt as Date, amount: d.totalFee || 0 }));
    const feeRows = recentDelivered.map((d) => ({ at: d.deliveredAt as Date, amount: (d.totalFee || 0) * (1 - COMMISSION_RATE) }));

    res.json({
      success: true,
      data: {
        stats: {
          totalRevenue: bucketize(revRows, totalRevenue),
          platformFees: bucketize(feeRows, platformFees),
          netRevenue: bucketize(feeRows, platformFees),
          pendingPayouts: pendingEarnings._sum.amount || 0,
        },
        rows: list.map((d) => ({
          id: d.id,
          orderTag: d.orderTag,
          orderName: d.packageName,
          customer: fullName(d.customer),
          rider: fullName(d.rider?.user),
          orderTotal: d.totalFee,
          platformFee: Math.round((d.totalFee || 0) * (1 - COMMISSION_RATE)),
          netRevenue: Math.round((d.totalFee || 0) * (1 - COMMISSION_RATE)),
          date: d.deliveredAt ?? d.createdAt,
        })),
      },
    });
  })
);

// ─── PAYOUTS ─────────────────────────────────────────────
router.get(
  '/payouts',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, paid, pending, failed, recent, list] = await Promise.all([
      prisma.payout.count(),
      prisma.payout.count({ where: { status: 'PAID' } }),
      prisma.payout.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      prisma.payout.count({ where: { status: 'FAILED' } }),
      prisma.payout.findMany({ where: { createdAt: { gte: SIXTY_DAYS_AGO() } }, select: { createdAt: true, status: true } }),
      prisma.payout.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          rider: {
            include: {
              user: { select: { firstName: true, lastName: true } },
              payoutAccount: { select: { bankName: true, accountNumber: true } },
            },
          },
        },
      }),
    ]);

    const rows = (f: (s: string) => boolean) => recent.filter((p) => f(p.status)).map((p) => ({ at: p.createdAt }));
    res.json({
      success: true,
      data: {
        stats: {
          total: bucketize(rows(() => true), total),
          paid: bucketize(rows((s) => s === 'PAID'), paid),
          pending: bucketize(rows((s) => s === 'PENDING' || s === 'PROCESSING'), pending),
          failed: bucketize(rows((s) => s === 'FAILED'), failed),
        },
        payouts: list.map((p) => ({
          id: p.id,
          rider: fullName(p.rider.user),
          amount: p.amount,
          bank: p.rider.payoutAccount?.bankName ?? '—',
          account: p.rider.payoutAccount?.accountNumber ?? '—',
          date: p.paidAt ?? p.createdAt,
          status: p.status,
        })),
      },
    });
  })
);

// ─── REFERRALS ───────────────────────────────────────────
router.get(
  '/referrals',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, claimed, pending, recent, list] = await Promise.all([
      prisma.referral.count(),
      prisma.referral.count({ where: { isPaid: true } }),
      prisma.referral.count({ where: { isPaid: false } }),
      prisma.referral.findMany({ where: { createdAt: { gte: SIXTY_DAYS_AGO() } }, select: { createdAt: true, isPaid: true } }),
      prisma.referral.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          referrer: { select: { firstName: true, lastName: true, referralCode: true } },
          referred: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        stats: {
          total: bucketize(recent.map((r) => ({ at: r.createdAt })), total),
          claimed: bucketize(recent.filter((r) => r.isPaid).map((r) => ({ at: r.createdAt })), claimed),
          pending: bucketize(recent.filter((r) => !r.isPaid).map((r) => ({ at: r.createdAt })), pending),
        },
        referrals: list.map((r) => ({
          id: r.id,
          referrer: fullName(r.referrer),
          referee: fullName(r.referred),
          code: r.referrer.referralCode,
          date: r.createdAt,
          reward: r.bonusAmount,
          status: r.isPaid ? 'Claimed' : 'Pending',
        })),
      },
    });
  })
);

// ─── SUPPORT ─────────────────────────────────────────────
router.get(
  '/support',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, open, resolved, recent, list] = await Promise.all([
      prisma.supportChat.count(),
      prisma.supportChat.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.supportChat.count({ where: { status: { in: ['RESOLVED', 'CLOSED'] } } }),
      prisma.supportChat.findMany({ where: { createdAt: { gte: SIXTY_DAYS_AGO() } }, select: { createdAt: true, status: true } }),
      prisma.supportChat.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 50,
        include: {
          user: { select: { firstName: true, lastName: true, role: true } },
          messages: { orderBy: { createdAt: 'asc' }, take: 1 },
        },
      }),
    ]);

    const rows = (f: (s: string) => boolean) => recent.filter((t) => f(t.status)).map((t) => ({ at: t.createdAt }));
    res.json({
      success: true,
      data: {
        stats: {
          total: bucketize(rows(() => true), total),
          open: bucketize(rows((s) => s === 'OPEN' || s === 'IN_PROGRESS'), open),
          resolved: bucketize(rows((s) => s === 'RESOLVED' || s === 'CLOSED'), resolved),
        },
        tickets: list.map((t) => ({
          id: t.id,
          ref: `#TX-${t.id.slice(0, 5).toUpperCase()}`,
          customer: fullName(t.user),
          userType: t.user.role === 'RIDER' ? 'Rider' : 'Customer',
          subject: t.subject,
          description: t.messages[0]?.content ?? '',
          date: t.createdAt,
          status: t.status === 'RESOLVED' || t.status === 'CLOSED' ? 'Resolved' : 'Open',
        })),
      },
    });
  })
);

// ─── SUPPORT CHAT (admin ↔ customer / rider) ─────────────
router.get(
  '/support/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const chat = await prisma.supportChat.findUnique({
      where: { id: String(req.params.id) },
      include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } },
    });
    if (!chat) throw new AppError('Ticket not found', 404);

    const messages = await prisma.supportMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      take: 300,
    });

    res.json({
      success: true,
      data: {
        chat: {
          id: chat.id,
          subject: chat.subject,
          status: chat.status,
          user: { id: chat.user.id, name: fullName(chat.user), role: chat.user.role },
        },
        messages,
      },
    });
  })
);

router.post(
  '/support/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const content = (req.body?.content ?? '').toString().trim();
    if (!content) throw new AppError('Message cannot be empty', 400);

    const chat = await prisma.supportChat.findUnique({ where: { id: String(req.params.id) } });
    if (!chat) throw new AppError('Ticket not found', 404);
    if (chat.status === 'CLOSED') throw new AppError('This chat has been closed', 400);

    const message = await prisma.supportMessage.create({
      data: { chatId: chat.id, senderId: req.user!.userId, content, isAgent: true },
    });
    await prisma.supportChat.update({
      where: { id: chat.id },
      data: { status: chat.status === 'OPEN' ? 'IN_PROGRESS' : chat.status, updatedAt: new Date() },
    });

    emitSupportMessage(chat.id, message);
    // Notify the user unless they already have the chat open.
    if (!isUserInRoom(chat.userId, `support:${chat.id}`)) {
      const preview = content.length > 80 ? `${content.slice(0, 77)}…` : content;
      emitNotification(chat.userId, {
        type: 'SYSTEM',
        title: 'Support replied',
        body: preview,
        data: {
          chatId: chat.id,
          action: { label: 'Open chat', variant: 'purple', route: `/support/chat?chatId=${chat.id}` },
        },
      }).catch(() => {});
    }

    res.status(201).json({ success: true, data: message });
  })
);

router.patch(
  '/support/:id/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    const chat = await prisma.supportChat.findUnique({ where: { id: String(req.params.id) } });
    if (!chat) throw new AppError('Ticket not found', 404);
    const updated = await prisma.supportChat.update({
      where: { id: chat.id },
      data: { status: 'RESOLVED' },
    });
    emitNotification(chat.userId, {
      type: 'SYSTEM',
      title: 'Support ticket resolved',
      body: `Your ticket "${chat.subject}" has been resolved.`,
    });
    res.json({ success: true, data: { id: updated.id, status: updated.status } });
  })
);

// ─── TRACKING ────────────────────────────────────────────
router.get(
  '/tracking',
  asyncHandler(async (_req: Request, res: Response) => {
    const [liveOrders, issues] = await Promise.all([
      prisma.delivery.findMany({
        where: { status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { assignedAt: 'desc' },
        take: 20,
        include: {
          customer: { select: { firstName: true, lastName: true, phone: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } },
        },
      }),
      prisma.supportChat.findMany({
        where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: { select: { role: true } } },
      }),
    ]);

    res.json({
      success: true,
      data: {
        liveOrders: liveOrders.map((d) => ({
          id: d.id,
          orderTag: d.orderTag,
          customer: fullName(d.customer),
          customerPhone: d.customer.phone,
          rider: fullName(d.rider?.user),
          riderPhone: d.rider?.user?.phone ?? null,
          pickup: d.pickupAddress,
          dropoff: d.dropoffAddress,
          pickupLat: d.pickupLat,
          pickupLng: d.pickupLng,
          dropoffLat: d.dropoffLat,
          dropoffLng: d.dropoffLng,
          liveRiderLat: d.liveRiderLat,
          liveRiderLng: d.liveRiderLng,
          pickedUpAt: d.pickedUpAt,
          etaMinutes: d.estimatedMinutes,
          status: d.status,
        })),
        issues: issues.map((t) => ({
          id: t.id,
          ref: `#TX-${t.id.slice(0, 5).toUpperCase()}`,
          userType: t.user.role === 'RIDER' ? 'Rider' : 'Customer',
          issue: t.subject,
        })),
      },
    });
  })
);

// ─── INSIGHTS ────────────────────────────────────────────
router.get(
  '/insights',
  asyncHandler(async (_req: Request, res: Response) => {
    const sixMonthsAgo = dayStart(-183);
    const [recent, totalRiders, totalCustomers, totalDeliveries] = await Promise.all([
      prisma.delivery.findMany({
        where: { createdAt: { gte: sixMonthsAgo }, status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } },
        select: { createdAt: true, totalFee: true, deliveredAt: true, status: true },
      }),
      prisma.riderProfile.count(),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.delivery.count({ where: { status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } } }),
    ]);

    // Orders + revenue series at three granularities, so the chart's
    // period dropdown switches without another request.
    const bucketSeries = (starts: Date[], label: (d: Date) => string) =>
      starts.map((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : new Date(8640000000000000);
        const inBucket = recent.filter((d) => d.createdAt >= start && d.createdAt < end);
        return {
          label: label(start),
          orders: inBucket.length,
          revenue: Math.round(inBucket.reduce((s, d) => s + (d.totalFee || 0), 0)),
        };
      });

    const dayLbl = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const daily = bucketSeries(Array.from({ length: 7 }, (_, i) => dayStart(-(6 - i))), dayLbl);
    const weekly = bucketSeries(Array.from({ length: 8 }, (_, i) => dayStart(-7 * (7 - i) - 6)), (d) => dayLbl(d));
    const monthly = bucketSeries(
      Array.from({ length: 6 }, (_, i) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(1);
        d.setMonth(d.getMonth() - (5 - i));
        return d;
      }),
      (d) => d.toLocaleDateString('en-GB', { month: 'short' })
    );

    // Completion rate + peak delivered hours, per window.
    const fmtH = (h: number) => {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hr = h % 12 === 0 ? 12 : h % 12;
      return `${hr}:00${ampm}`;
    };
    const windowStats = (from: Date | null) => {
      const rows = from ? recent.filter((d) => d.createdAt >= from) : recent;
      const done = rows.filter((d) => d.status === 'DELIVERED').length;
      const terminal = rows.filter((d) => ['DELIVERED', 'CANCELLED', 'FAILED'].includes(d.status)).length;
      const hourCounts = new Map<number, number>();
      for (const d of rows) {
        if (!d.deliveredAt) continue;
        const h = d.deliveredAt.getHours();
        hourCounts.set(h, (hourCounts.get(h) || 0) + 1);
      }
      const peaks = [...hourCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([h], i) => ({
          label: i === 0 ? 'Highest Activity' : 'Moderate Activity',
          value: `${fmtH(h)} - ${fmtH((h + 2) % 24)}`,
        }));
      return { completionRate: terminal ? Math.round((done / terminal) * 100) : 100, peakHours: peaks };
    };

    const overall = windowStats(null);
    res.json({
      success: true,
      data: {
        series: { daily, weekly, monthly },
        totals: { riders: totalRiders, customers: totalCustomers, deliveries: totalDeliveries },
        windows: {
          overall,
          week: windowStats(dayStart(-6)),
          month: windowStats(dayStart(-29)),
        },
        // Legacy fields (kept so an older dashboard build keeps working)
        days: daily,
        completionRate: overall.completionRate,
        peakHours: overall.peakHours,
      },
    });
  })
);

export default router;
