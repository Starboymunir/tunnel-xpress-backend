import crypto from 'crypto';
import prisma from './prisma';
import { config } from '../config';

/** Generate a 6-digit OTP */
export function generateOTPCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/** Create and store an OTP for email or phone */
export async function createOTP(identifier: string): Promise<string> {
  // Invalidate existing unused OTPs for this identifier
  await prisma.oTP.updateMany({
    where: { identifier, isUsed: false },
    data: { isUsed: true },
  });

  const code = generateOTPCode();
  const expiresAt = new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);

  await prisma.oTP.create({
    data: { identifier, code, expiresAt },
  });

  return code;
}

/** Verify an OTP code */
export async function verifyOTP(identifier: string, code: string): Promise<boolean> {
  const otp = await prisma.oTP.findFirst({
    where: {
      identifier,
      code,
      isUsed: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) return false;

  await prisma.oTP.update({
    where: { id: otp.id },
    data: { isUsed: true },
  });

  return true;
}
