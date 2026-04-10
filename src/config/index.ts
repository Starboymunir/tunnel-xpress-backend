import dotenv from 'dotenv';
dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  db: {
    url: process.env.DATABASE_URL!,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10),
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
  },

  google: {
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

  pricing: {
    baseFee: parseFloat(process.env.BASE_FEE_NGN || '500'),
    perKmFee: parseFloat(process.env.PER_KM_FEE_NGN || '100'),
    surgeMultiplier: parseFloat(process.env.SURGE_MULTIPLIER || '1.0'),
  },

  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:8081',
  },

  termii: {
    apiKey: process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || 'TunnelXpr',
  },
};
