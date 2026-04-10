import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { z } from 'zod';
import { validateQuery } from '../middleware/validate';

const router = Router();

router.use(authenticate);

const querySchema = z.object({
  type: z.string().optional(),
  unreadOnly: z.string().optional().transform((v) => v === 'true'),
  page: z.string().default('1').transform(Number),
  limit: z.string().default('30').transform(Number),
});

// ─── LIST NOTIFICATIONS ─────────────────────────────────

router.get(
  '/',
  validateQuery(querySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { type, unreadOnly, page, limit } = req.query as any;

    const where: any = { userId: req.user!.userId };
    if (type) where.type = type;
    if (unreadOnly) where.isRead = false;

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId: req.user!.userId, isRead: false },
      }),
    ]);

    res.json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  })
);

// ─── MARK AS READ ───────────────────────────────────────

router.patch(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.notification.updateMany({
      where: { id: req.params.id as string, userId: req.user!.userId },
      data: { isRead: true },
    });

    res.json({ success: true });
  })
);

// ─── MARK ALL AS READ ───────────────────────────────────

router.patch(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.userId, isRead: false },
      data: { isRead: true },
    });

    res.json({ success: true });
  })
);

// ─── UNREAD COUNT ───────────────────────────────────────

router.get(
  '/unread-count',
  asyncHandler(async (req: Request, res: Response) => {
    const count = await prisma.notification.count({
      where: { userId: req.user!.userId, isRead: false },
    });

    res.json({ success: true, data: { count } });
  })
);

export default router;
