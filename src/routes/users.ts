import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateProfileSchema, updateSettingsSchema } from '../schemas';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── CHANGE PASSWORD ────────────────────────────────────
router.patch(
  '/password',
  asyncHandler(async (req: Request, res: Response) => {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');
    if (newPassword.length < 8) throw new AppError('New password must be at least 8 characters', 400);

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { passwordHash: true } });
    if (!user?.passwordHash) throw new AppError('This account has no password set', 400);
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw new AppError('Current password is incorrect', 401);

    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 12) },
    });
    res.json({ success: true, message: 'Password updated' });
  })
);

// ─── GET PROFILE ────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        role: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        referralCode: true,
        createdAt: true,
        wallet: { select: { balance: true, currency: true } },
      },
    });

    if (!user) throw new AppError('User not found', 404);

    res.json({ success: true, data: user });
  })
);

// ─── UPDATE PROFILE ─────────────────────────────────────

router.patch(
  '/',
  validate(updateProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { firstName, lastName, phone, email } = req.body;

    // Check uniqueness if changing email or phone
    if (email) {
      const existing = await prisma.user.findFirst({
        where: { email, NOT: { id: req.user!.userId } },
      });
      if (existing) throw new AppError('Email already in use', 409);
    }

    if (phone) {
      const existing = await prisma.user.findFirst({
        where: { phone, NOT: { id: req.user!.userId } },
      });
      if (existing) throw new AppError('Phone number already in use', 409);
    }

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        ...(firstName && { firstName }),
        ...(lastName && { lastName }),
        ...(phone && { phone, isPhoneVerified: false }),
        ...(email && { email, isEmailVerified: false }),
      },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        isEmailVerified: true,
        isPhoneVerified: true,
      },
    });

    res.json({ success: true, data: user });
  })
);

// ─── UPDATE AVATAR ──────────────────────────────────────

router.patch(
  '/avatar',
  asyncHandler(async (req: Request, res: Response) => {
    const { avatarUrl } = req.body;
    if (!avatarUrl) throw new AppError('Avatar URL is required', 400);

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { avatarUrl },
      select: { id: true, avatarUrl: true },
    });

    res.json({ success: true, data: user });
  })
);

// ─── GET SETTINGS ───────────────────────────────────────

router.get(
  '/settings',
  asyncHandler(async (req: Request, res: Response) => {
    let settings = await prisma.userSettings.findUnique({
      where: { userId: req.user!.userId },
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId: req.user!.userId },
      });
    }

    res.json({ success: true, data: settings });
  })
);

// ─── UPDATE SETTINGS ────────────────────────────────────

router.patch(
  '/settings',
  validate(updateSettingsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const settings = await prisma.userSettings.upsert({
      where: { userId: req.user!.userId },
      update: req.body,
      create: { userId: req.user!.userId, ...req.body },
    });

    res.json({ success: true, data: settings });
  })
);

// ─── DELETE ACCOUNT ─────────────────────────────────────

router.delete(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { isActive: false },
    });

    res.json({ success: true, message: 'Account deactivated' });
  })
);

export default router;
