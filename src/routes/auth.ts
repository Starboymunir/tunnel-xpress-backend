import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { generateTokenPair, verifyRefreshToken } from '../lib/tokens';
import { createOTP, verifyOTP } from '../lib/otp';
import { sendOtpEmail } from '../lib/email';
import { sendOtpSms, smsProviderConfigured } from '../lib/sms';
import { generateReferralCode } from '../lib/generators';
import {
  registerEmailSchema,
  registerGoogleSchema,
  registerPhoneSchema,
  loginEmailSchema,
  loginPhoneSchema,
  verifyOTPSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  refreshTokenSchema,
} from '../schemas';

const router = Router();

// ─── REGISTER OR LOGIN WITH GOOGLE ─────────────────────

router.post(
  '/register/google',
  validate(registerGoogleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, firstName, lastName, avatarUrl } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });

    let user;
    if (existing) {
      user = await prisma.user.update({
        where: { id: existing.id },
        data: {
          firstName: firstName ?? existing.firstName,
          lastName: lastName ?? existing.lastName,
          avatarUrl: avatarUrl ?? existing.avatarUrl,
          authProvider: 'GOOGLE',
          isEmailVerified: true,
        },
      });
    } else {
      const refCode = generateReferralCode(firstName || 'user');
      user = await prisma.user.create({
        data: {
          email,
          firstName,
          lastName,
          avatarUrl,
          authProvider: 'GOOGLE',
          isEmailVerified: true,
          referralCode: refCode,
          settings: { create: {} },
          wallet: { create: {} },
        },
      });
    }

    if (!user.isActive) throw new AppError('Account is deactivated', 403);

    const tokens = generateTokenPair({ userId: user.id, role: user.role });

    res.json({
      success: true,
      message: 'Google authentication successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          avatarUrl: user.avatarUrl,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified,
          referralCode: user.referralCode,
        },
        ...tokens,
      },
    });
  })
);

// ─── REGISTER WITH EMAIL ────────────────────────────────

router.post(
  '/register/email',
  validate(registerEmailSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email: rawEmail, password, firstName, lastName, referralCode } = req.body;
    const email = rawEmail.trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError('Email already registered', 409);

    const passwordHash = await bcrypt.hash(password, 12);
    const refCode = generateReferralCode(firstName);

    // Check referral
    let referrerId: string | undefined;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
      if (referrer) referrerId = referrer.id;
    }

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName,
        lastName,
        authProvider: 'EMAIL',
        referralCode: refCode,
        referredBy: referrerId,
        settings: { create: {} },
        wallet: { create: {} },
      },
    });

    // Create referral record
    if (referrerId) {
      await prisma.referral.create({
        data: { referrerId, referredId: user.id, bonusAmount: 200 },
      });
    }

    // Send verification OTP
    const otpCode = await createOTP(email);
    console.log(`[DEV] Email OTP for ${email}: ${otpCode}`);
    await sendOtpEmail(email, otpCode);

    const tokens = generateTokenPair({ userId: user.id, role: user.role });

    res.status(201).json({
      success: true,
      message: 'Account created. Please verify your email.',
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          referralCode: user.referralCode,
        },
        ...tokens,
      },
    });
  })
);

// ─── REGISTER WITH PHONE ────────────────────────────────

router.post(
  '/register/phone',
  validate(registerPhoneSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { phone, firstName, lastName, referralCode } = req.body;

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) throw new AppError('Phone number already registered', 409);

    const refCode = generateReferralCode(firstName);

    let referrerId: string | undefined;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
      if (referrer) referrerId = referrer.id;
    }

    const user = await prisma.user.create({
      data: {
        phone,
        firstName,
        lastName,
        authProvider: 'PHONE',
        referralCode: refCode,
        referredBy: referrerId,
        settings: { create: {} },
        wallet: { create: {} },
      },
    });

    if (referrerId) {
      await prisma.referral.create({
        data: { referrerId, referredId: user.id, bonusAmount: 200 },
      });
    }

    // Send OTP via SMS (Termii). When no provider is configured, surface the
    // code so the account can still be verified during testing.
    const otpCode = await createOTP(phone);
    await sendOtpSms(phone, otpCode);

    res.status(201).json({
      success: true,
      message: 'OTP sent to your phone.',
      data: { phone, otpSent: true, ...(smsProviderConfigured() ? {} : { devCode: otpCode }) },
    });
  })
);

// ─── LOGIN WITH EMAIL ───────────────────────────────────

router.post(
  '/login/email',
  validate(loginEmailSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email: rawEmail, password } = req.body;
    const email = rawEmail.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new AppError('Invalid email or password', 401);
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError('Invalid email or password', 401);

    if (!user.isActive) throw new AppError('Account is deactivated', 403);

    const tokens = generateTokenPair({ userId: user.id, role: user.role });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          avatarUrl: user.avatarUrl,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified,
          referralCode: user.referralCode,
        },
        ...tokens,
      },
    });
  })
);

// ─── LOGIN WITH PHONE (OTP) ─────────────────────────────

router.post(
  '/login/phone',
  validate(loginPhoneSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { phone } = req.body;

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) throw new AppError('Phone number not registered', 404);
    if (!user.isActive) throw new AppError('Account is deactivated', 403);

    const otpCode = await createOTP(phone);
    await sendOtpSms(phone, otpCode);

    res.json({
      success: true,
      message: 'OTP sent to your phone.',
      data: { phone, otpSent: true, ...(smsProviderConfigured() ? {} : { devCode: otpCode }) },
    });
  })
);

// ─── VERIFY OTP ─────────────────────────────────────────

router.post(
  '/verify-otp',
  validate(verifyOTPSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { identifier, code } = req.body;

    const isValid = await verifyOTP(identifier, code);
    if (!isValid) throw new AppError('Invalid or expired OTP', 400);

    // Find user and update verification status
    const isEmail = identifier.includes('@');
    const user = await prisma.user.findFirst({
      where: isEmail ? { email: identifier } : { phone: identifier },
    });

    if (!user) throw new AppError('User not found', 404);

    await prisma.user.update({
      where: { id: user.id },
      data: isEmail ? { isEmailVerified: true } : { isPhoneVerified: true },
    });

    const tokens = generateTokenPair({ userId: user.id, role: user.role });

    res.json({
      success: true,
      message: 'Verification successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          isEmailVerified: isEmail ? true : user.isEmailVerified,
          isPhoneVerified: !isEmail ? true : user.isPhoneVerified,
        },
        ...tokens,
      },
    });
  })
);

// ─── RESEND OTP ─────────────────────────────────────────

router.post(
  '/resend-otp',
  asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.body;
    if (!identifier) throw new AppError('Email or phone is required', 400);

    const otpCode = await createOTP(identifier);
    const isEmail = identifier.includes('@');
    if (isEmail) {
      await sendOtpEmail(identifier, otpCode);
    } else {
      await sendOtpSms(identifier, otpCode);
    }

    res.json({
      success: true,
      message: 'OTP resent successfully',
      data: !isEmail && !smsProviderConfigured() ? { devCode: otpCode } : undefined,
    });
  })
);

// ─── FORGOT PASSWORD ────────────────────────────────────

router.post(
  '/forgot-password',
  validate(forgotPasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const email = (req.body.email as string).trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't reveal if email exists
      return res.json({
        success: true,
        message: 'If the email is registered, a reset OTP has been sent.',
      });
    }

    const otpCode = await createOTP(email);
    console.log(`[DEV] Password reset OTP for ${email}: ${otpCode}`);
    await sendOtpEmail(email, otpCode);

    res.json({
      success: true,
      message: 'If the email is registered, a reset OTP has been sent.',
    });
  })
);

// ─── RESET PASSWORD ─────────────────────────────────────

router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { identifier: rawIdentifier, code, newPassword } = req.body;
    const identifier = rawIdentifier.includes('@') ? rawIdentifier.trim().toLowerCase() : rawIdentifier.trim();

    const isValid = await verifyOTP(identifier, code);
    if (!isValid) throw new AppError('Invalid or expired OTP', 400);

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { email: identifier },
      data: { passwordHash },
    });

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  })
);

// ─── REFRESH TOKEN ──────────────────────────────────────

router.post(
  '/refresh-token',
  validate(refreshTokenSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;

    const decoded = verifyRefreshToken(refreshToken);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new AppError('User not found or deactivated', 401);
    }

    const tokens = generateTokenPair({ userId: user.id, role: user.role });

    res.json({
      success: true,
      data: tokens,
    });
  })
);

// ─── GET CURRENT USER ───────────────────────────────────

router.get(
  '/me',
  authenticate,
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
      },
    });

    res.json({ success: true, data: user });
  })
);

export default router;
