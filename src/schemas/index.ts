import { z } from 'zod';

// ─── AUTH ───────────────────────────────────────────────

export const registerEmailSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  referralCode: z.string().optional(),
});

export const registerPhoneSchema = z.object({
  phone: z.string().min(10, 'Invalid phone number').max(15),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  referralCode: z.string().optional(),
});

export const registerGoogleSchema = z.object({
  email: z.string().email('Invalid email address'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  googleId: z.string().optional(),
});

export const loginEmailSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const loginPhoneSchema = z.object({
  phone: z.string().min(10, 'Invalid phone number'),
});

export const verifyOTPSchema = z.object({
  identifier: z.string().min(1, 'Email or phone is required'),
  code: z.string().length(6, 'OTP must be 6 digits'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  identifier: z.string().min(1),
  code: z.string().length(6),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ─── USER PROFILE ───────────────────────────────────────

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(10).max(15).optional(),
  email: z.string().email().optional(),
});

export const updateSettingsSchema = z.object({
  pushNotifications: z.boolean().optional(),
  emailNotifications: z.boolean().optional(),
  smsNotifications: z.boolean().optional(),
  biometricLogin: z.boolean().optional(),
  language: z.string().optional(),
  darkMode: z.boolean().optional(),
});

// ─── DELIVERY ───────────────────────────────────────────

export const createDeliverySchema = z.object({
  pickupAddress: z.string().min(1, 'Pickup address is required'),
  pickupLat: z.number(),
  pickupLng: z.number(),
  pickupContactName: z.string().optional(),
  pickupContactPhone: z.string().optional(),
  pickupNote: z.string().optional(),

  dropoffAddress: z.string().min(1, 'Dropoff address is required'),
  dropoffLat: z.number(),
  dropoffLng: z.number(),
  dropoffContactName: z.string().optional(),
  dropoffContactPhone: z.string().optional(),
  dropoffNote: z.string().optional(),

  packageName: z.string().min(1, 'Package name is required'),
  packageDescription: z.string().optional(),
  packageImageUrl: z.string().optional(),
  riderType: z.enum(['BIKE', 'CAR', 'VAN']).default('BIKE'),
  specialInstructions: z.string().optional(),

  couponCode: z.string().optional(),
});

export const rateDeliverySchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().optional(),
});

// ─── PAYMENT ────────────────────────────────────────────

export const initPaymentSchema = z.object({
  deliveryId: z.string().uuid(),
  method: z.enum(['CARD', 'BANK_TRANSFER', 'OPAY', 'WALLET']).default('CARD'),
  savedCardId: z.string().uuid().optional(),
});

export const verifyPaymentSchema = z.object({
  reference: z.string().min(1, 'Payment reference is required'),
});

// ─── LOCATION ───────────────────────────────────────────

export const savedLocationSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  address: z.string().min(1, 'Address is required'),
  landmark: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  isDefault: z.boolean().optional(),
});

export const updateLocationSchema = savedLocationSchema.partial();

// ─── SUPPORT ────────────────────────────────────────────

export const createChatSchema = z.object({
  subject: z.string().min(1, 'Subject is required'),
  message: z.string().min(1, 'Message is required'),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required'),
});

// ─── COUPON ─────────────────────────────────────────────

export const applyCouponSchema = z.object({
  code: z.string().min(1, 'Coupon code is required'),
  orderAmount: z.number().positive(),
});

// ─── REFERRAL ───────────────────────────────────────────

export const applyReferralSchema = z.object({
  code: z.string().min(1, 'Referral code is required'),
});

// ─── CALCULATE FEE ──────────────────────────────────────

export const calculateFeeSchema = z.object({
  pickupLat: z.number(),
  pickupLng: z.number(),
  dropoffLat: z.number(),
  dropoffLng: z.number(),
  riderType: z.enum(['BIKE', 'CAR', 'VAN']).default('BIKE'),
});

// ─── RIDER VERIFICATION (KYC) ───────────────────────────

export const submitVerificationSchema = z.object({
  // Personal details
  fullName: z.string().min(3, 'Full name is required'),
  dateOfBirth: z.string().min(1, 'Date of birth is required'),
  homeAddress: z.string().optional(),
  phone: z.string().optional(),
  // Government ID
  idType: z.string().min(1, 'ID type is required'),
  idFrontUrl: z.string().min(1, 'A front-of-ID image is required'),
  idBackUrl: z.string().optional(),
  // Selfie
  selfieUrl: z.string().min(1, 'A selfie is required'),
  // Rider permit
  permitType: z.string().min(1, 'Permit type is required'),
  permitNumber: z.string().min(1, 'Permit number is required'),
  permitExpiry: z.string().min(1, 'Permit expiry is required'),
  permitUrl: z.string().min(1, 'A permit image is required'),
  // Vehicle
  plateNumber: z.string().min(1, 'Plate number is required'),
  vehicleColor: z.string().optional(),
  vehiclePhotoUrl: z.string().optional(),
});

export const reviewVerificationSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
});

export const rateCustomerSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().optional(),
});

export const payoutAccountSchema = z.object({
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  bankCode: z.string().min(1, 'Bank is required'),
  bankName: z.string().min(1, 'Bank is required'),
  accountName: z.string().min(1, 'Account name is required'),
});
