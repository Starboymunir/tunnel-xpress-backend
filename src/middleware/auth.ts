import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../lib/errors';
import prisma from '../lib/prisma';

export interface AuthPayload {
  userId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/** Require valid JWT access token */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401);
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, config.jwt.secret) as AuthPayload;

    // Ensure user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new AppError('User not found or deactivated', 401);
    }

    req.user = { userId: user.id, role: user.role };
    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    if (err instanceof jwt.JsonWebTokenError) {
      return next(new AppError('Invalid or expired token', 401));
    }
    next(err);
  }
}

/** Require specific roles */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError('Insufficient permissions', 403));
    }
    next();
  };
}
