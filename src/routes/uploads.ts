import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { AppError } from '../lib/errors';

const router = Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('Only image files (JPEG, PNG, WebP, GIF) are allowed', 400) as any);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

router.use(authenticate);

// ─── UPLOAD IMAGE ───────────────────────────────────────

router.post(
  '/image',
  upload.single('image'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw new AppError('No image file provided', 400);

    // In production, upload to Cloudinary/S3 and return the URL
    // For now, return local path
    const url = `/uploads/${req.file.filename}`;

    res.json({
      success: true,
      data: { url, filename: req.file.filename },
    });
  })
);

export default router;
