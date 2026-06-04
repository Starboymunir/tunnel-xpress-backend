import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { AppError } from '../lib/errors';
import { config } from '../config';

const router = Router();

// Configure Cloudinary if credentials are present
if (config.cloudinary.enabled) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
  });
}

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('Only image files (JPEG, PNG, WebP, GIF) are allowed', 400) as any);
  }
};

// Keep the file in memory so we can stream it to Cloudinary (or write to disk as fallback)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

/** Upload a buffer to Cloudinary, resolving to its secure (https) URL. */
function uploadToCloudinary(buffer: Buffer): Promise<{ url: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: config.cloudinary.folder, resource_type: 'image' },
      (err, result) => {
        if (err || !result) return reject(err || new AppError('Cloudinary upload failed', 502));
        resolve({ url: result.secure_url, filename: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

/** Fallback: persist to the local uploads dir and return a relative URL. */
function saveLocally(file: Express.Multer.File): { url: string; filename: string } {
  const dir = path.join(__dirname, '../../uploads');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname) || '.jpg'}`;
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  return { url: `/uploads/${filename}`, filename };
}

router.use(authenticate);

// ─── UPLOAD IMAGE ───────────────────────────────────────

router.post(
  '/image',
  upload.single('image'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw new AppError('No image file provided', 400);

    const result = config.cloudinary.enabled
      ? await uploadToCloudinary(req.file.buffer)
      : saveLocally(req.file);

    res.json({
      success: true,
      data: result,
    });
  })
);

export default router;
