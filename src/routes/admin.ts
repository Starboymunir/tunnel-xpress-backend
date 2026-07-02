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
    const [total, active, completed, canceled, tToday, tYest, list] = await Promise.all([
      prisma.delivery.count(),
      prisma.delivery.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
      prisma.delivery.count({ where: { status: 'DELIVERED' } }),
      prisma.delivery.count({ where: { status: { in: ['CANCELLED', 'FAILED'] } } }),
      prisma.delivery.count({ where: { createdAt: { gte: dayStart() } } }),
      prisma.delivery.count({ where: { createdAt: { gte: dayStart(-1), lt: dayStart() } } }),
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

    res.json({
      success: true,
      data: {
        stats: { total, active, completed, canceled, deltaPct: delta(tToday, tYest) },
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
    const [total, activeIds, customers] = await Promise.all([
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
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
        stats: { total, active, inactive: Math.max(0, total - active) },
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
    const [total, online, offline, busy, riders] = await Promise.all([
      prisma.riderProfile.count(),
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
        stats: { total, online, offline, busy },
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
    const [agg, pendingEarnings, list] = await Promise.all([
      prisma.delivery.aggregate({ where: { status: 'DELIVERED' }, _sum: { totalFee: true } }),
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

    res.json({
      success: true,
      data: {
        stats: {
          totalRevenue,
          platformFees,
          netRevenue: platformFees,
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
    const [total, paid, pending, failed, list] = await Promise.all([
      prisma.payout.count(),
      prisma.payout.count({ where: { status: 'PAID' } }),
      prisma.payout.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      prisma.payout.count({ where: { status: 'FAILED' } }),
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

    res.json({
      success: true,
      data: {
        stats: { total, paid, pending, failed },
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
    const [total, claimed, pending, list] = await Promise.all([
      prisma.referral.count(),
      prisma.referral.count({ where: { isPaid: true } }),
      prisma.referral.count({ where: { isPaid: false } }),
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
        stats: { total, claimed, pending },
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
    const [total, open, resolved, list] = await Promise.all([
      prisma.supportChat.count(),
      prisma.supportChat.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.supportChat.count({ where: { status: { in: ['RESOLVED', 'CLOSED'] } } }),
      prisma.supportChat.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 50,
        include: {
          user: { select: { firstName: true, lastName: true, role: true } },
          messages: { orderBy: { createdAt: 'asc' }, take: 1 },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        stats: { total, open, resolved },
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
    const weekAgo = dayStart(-6);
    const [recent, totalRiders, totalCustomers, totalDeliveries, delivered, terminal] = await Promise.all([
      prisma.delivery.findMany({
        where: { createdAt: { gte: weekAgo }, status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } },
        select: { createdAt: true, totalFee: true, deliveredAt: true },
      }),
      prisma.riderProfile.count(),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.delivery.count({ where: { status: { notIn: ['DRAFT', 'PENDING_PAYMENT'] } } }),
      prisma.delivery.count({ where: { status: 'DELIVERED' } }),
      prisma.delivery.count({ where: { status: { in: ['DELIVERED', 'CANCELLED', 'FAILED'] } } }),
    ]);

    // Orders + revenue per day for the last 7 days.
    const days: { label: string; orders: number; revenue: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const start = dayStart(-i);
      const end = dayStart(-i + 1);
      const inDay = recent.filter((d) => d.createdAt >= start && d.createdAt < end);
      days.push({
        label: start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        orders: inDay.length,
        revenue: inDay.reduce((s, d) => s + (d.totalFee || 0), 0),
      });
    }

    // Peak delivered hours histogram.
    const hourCounts = new Map<number, number>();
    for (const d of recent) {
      if (!d.deliveredAt) continue;
      const h = d.deliveredAt.getHours();
      hourCounts.set(h, (hourCounts.get(h) || 0) + 1);
    }
    const fmtH = (h: number) => {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hr = h % 12 === 0 ? 12 : h % 12;
      return `${hr}:00${ampm}`;
    };
    const peaks = [...hourCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h], i) => ({
        label: i === 0 ? 'Highest Activity' : 'Moderate Activity',
        value: `${fmtH(h)} - ${fmtH((h + 2) % 24)}`,
      }));

    res.json({
      success: true,
      data: {
        days,
        totals: { riders: totalRiders, customers: totalCustomers, deliveries: totalDeliveries },
        completionRate: terminal ? Math.round((delivered / terminal) * 100) : 100,
        peakHours: peaks,
      },
    });
  })
);

export default router;
