import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';

export function generateAccessToken(payload: AuthPayload): string {
  return jwt.sign(payload as object, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

export function generateRefreshToken(payload: AuthPayload): string {
  return jwt.sign(payload as object, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
}

export function verifyRefreshToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as AuthPayload;
}

export function generateTokenPair(payload: AuthPayload) {
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  };
}
