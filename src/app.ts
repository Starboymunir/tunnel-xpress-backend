import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from './config';
import { errorHandler, notFound } from './lib/errors';

// Route imports
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import deliveryRoutes from './routes/deliveries';
import paymentRoutes, { handlePaystackWebhook } from './routes/payments';
import notificationRoutes from './routes/notifications';
import referralRoutes from './routes/referrals';
import locationRoutes from './routes/locations';
import supportRoutes from './routes/support';
import promoRoutes from './routes/promos';
import uploadRoutes from './routes/uploads';
import adminRoutes from './routes/admin';
import riderRoutes from './routes/riders';
import ratingRoutes from './routes/ratings';
import bankRoutes from './routes/banks';

const app = express();

// ─── SECURITY ───────────────────────────────────────────

app.use(helmet());
app.use(cors({
  origin: config.cors.origin === '*' ? true : config.cors.origin,
  credentials: true,
}));

// ─── RATE LIMITING ──────────────────────────────────────

// Behind Render's load balancer: without this, req.ip is the proxy address and
// every client shares ONE rate-limit bucket (one tester can lock out everyone).
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // per client IP — the app polls tracking/notifications frequently
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // per client IP
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ─── BODY PARSING ───────────────────────────────────────

// Paystack webhook needs raw body for signature verification
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── STATIC FILES ───────────────────────────────────────

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ─── HEALTH CHECK ───────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Tunnel Express API is running',
    env: config.env,
    timestamp: new Date().toISOString(),
  });
});

// ─── API ROUTES ─────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/promos', promoRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/riders', riderRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/banks', bankRoutes);

// ─── ERROR HANDLING ─────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

export default app;
