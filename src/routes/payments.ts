import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { initPaymentSchema, verifyPaymentSchema } from '../schemas';
import { config } from '../config';

const router = Router();

// Fake mode: when no Paystack secret key is configured (or the value looks
// like a placeholder), simulate successful payments end-to-end so the rest
// of the flow can be tested without keys.
const PAYSTACK_KEY = (config.paystack.secretKey || '').trim();
const FAKE_PAYMENTS =
  !PAYSTACK_KEY ||
  PAYSTACK_KEY.includes('xxx') ||
  PAYSTACK_KEY.toLowerCase() === 'sk_test_' ||
  PAYSTACK_KEY.length < 20;
if (FAKE_PAYMENTS) {
  // eslint-disable-next-line no-console
  console.warn('[payments] PAYSTACK_SECRET_KEY missing or placeholder — running in FAKE payment mode (all payments auto-succeed).');
}

router.use(authenticate);

// ─── INITIALIZE PAYMENT ─────────────────────────────────

router.post(
  '/initialize',
  validate(initPaymentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { deliveryId, method, savedCardId } = req.body;

    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) throw new AppError('Delivery not found', 404);
    if (delivery.customerId !== req.user!.userId) {
      throw new AppError('Not authorized', 403);
    }
    if (delivery.status !== 'PENDING_PAYMENT') {
      throw new AppError('Delivery is not awaiting payment', 400);
    }

    // Check for existing pending payment
    const existingPayment = await prisma.payment.findUnique({
      where: { deliveryId },
    });
    if (existingPayment && existingPayment.status === 'SUCCESS') {
      throw new AppError('Payment already completed', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { email: true },
    });

    const reference = `TXN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // ─── FAKE MODE ──────────────────────────────────────
    // No Paystack key configured: pretend the charge succeeded immediately.
    if (FAKE_PAYMENTS) {
      const payment = await prisma.payment.upsert({
        where: { deliveryId },
        update: {
          amount: delivery.totalFee,
          method,
          status: 'SUCCESS',
          paystackRef: reference,
        },
        create: {
          deliveryId,
          userId: req.user!.userId,
          amount: delivery.totalFee,
          method,
          status: 'SUCCESS',
          paystackRef: reference,
        },
      });

      // Mark as paid and awaiting a rider. The rider app drives the rest of
      // the lifecycle (accept → picked up → in transit → delivered).
      await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'FINDING_RIDER', paidAt: new Date() },
      });

      return res.json({
        success: true,
        data: {
          payment,
          requiresAction: false,
          reference,
          fake: true,
        },
      });
    }

    // If using saved card with authorization code
    if (savedCardId && method === 'CARD') {
      const savedCard = await prisma.savedCard.findFirst({
        where: { id: savedCardId, userId: req.user!.userId },
      });

      if (!savedCard) throw new AppError('Saved card not found', 404);

      // Charge the authorization
      const chargeResponse = await chargeAuthorization(
        savedCard.authCode,
        user!.email!,
        delivery.totalFee * 100, // Paystack uses kobo
        reference
      );

      const payment = await prisma.payment.upsert({
        where: { deliveryId },
        update: {
          amount: delivery.totalFee,
          method,
          status: chargeResponse.success ? 'SUCCESS' : 'FAILED',
          paystackRef: reference,
          paystackAuthCode: savedCard.authCode,
        },
        create: {
          deliveryId,
          userId: req.user!.userId,
          amount: delivery.totalFee,
          method,
          status: chargeResponse.success ? 'SUCCESS' : 'FAILED',
          paystackRef: reference,
          paystackAuthCode: savedCard.authCode,
        },
      });

      if (chargeResponse.success) {
        await prisma.delivery.update({
          where: { id: deliveryId },
          data: { status: 'FINDING_RIDER', paidAt: new Date() },
        });
      }

      return res.json({
        success: chargeResponse.success,
        data: {
          payment,
          requiresAction: false,
        },
      });
    }

    // Initialize new Paystack transaction
    const initResponse = await initializePaystackTransaction(
      user!.email!,
      delivery.totalFee * 100,
      reference,
      { deliveryId, userId: req.user!.userId }
    );

    const payment = await prisma.payment.upsert({
      where: { deliveryId },
      update: {
        amount: delivery.totalFee,
        method,
        paystackRef: reference,
        status: 'PENDING',
      },
      create: {
        deliveryId,
        userId: req.user!.userId,
        amount: delivery.totalFee,
        method,
        paystackRef: reference,
      },
    });

    res.json({
      success: true,
      data: {
        payment,
        requiresAction: true,
        authorizationUrl: initResponse.authorization_url,
        accessCode: initResponse.access_code,
        reference,
      },
    });
  })
);

// ─── VERIFY PAYMENT ─────────────────────────────────────

router.post(
  '/verify',
  validate(verifyPaymentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { reference } = req.body;

    const payment = await prisma.payment.findUnique({
      where: { paystackRef: reference },
    });

    if (!payment) throw new AppError('Payment not found', 404);
    if (payment.userId !== req.user!.userId) {
      throw new AppError('Not authorized', 403);
    }

    // ─── FAKE MODE ──────────────────────────────────────
    if (FAKE_PAYMENTS) {
      if (payment.status !== 'SUCCESS') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCESS' },
        });
        await prisma.delivery.update({
          where: { id: payment.deliveryId },
          data: { status: 'FINDING_RIDER', paidAt: new Date() },
        });
      }
      return res.json({
        success: true,
        message: 'Payment verified successfully (fake mode)',
        data: { status: 'SUCCESS', deliveryId: payment.deliveryId },
      });
    }

    // Verify with Paystack
    const verification = await verifyPaystackTransaction(reference);

    if (verification.status === 'success') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCESS',
          paystackAuthCode: verification.authorization?.authorization_code,
        },
      });

      await prisma.delivery.update({
        where: { id: payment.deliveryId },
        data: { status: 'PAID', paidAt: new Date() },
      });

      // Save card if reusable
      if (verification.authorization?.reusable && verification.authorization?.authorization_code) {
        const auth = verification.authorization;
        const existing = await prisma.savedCard.findFirst({
          where: {
            userId: payment.userId,
            last4: auth.last4,
            brand: auth.brand || auth.card_type,
          },
        });

        if (!existing) {
          await prisma.savedCard.create({
            data: {
              userId: payment.userId,
              last4: auth.last4,
              brand: auth.brand || auth.card_type,
              expMonth: parseInt(auth.exp_month, 10),
              expYear: parseInt(auth.exp_year, 10),
              authCode: auth.authorization_code,
              bank: auth.bank,
            },
          });
        }
      }

      return res.json({
        success: true,
        message: 'Payment verified successfully',
        data: { status: 'SUCCESS', deliveryId: payment.deliveryId },
      });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED' },
    });

    res.json({
      success: false,
      message: 'Payment verification failed',
      data: { status: 'FAILED', deliveryId: payment.deliveryId },
    });
  })
);

// ─── GET SAVED CARDS ────────────────────────────────────

router.get(
  '/cards',
  asyncHandler(async (req: Request, res: Response) => {
    const cards = await prisma.savedCard.findMany({
      where: { userId: req.user!.userId },
      select: {
        id: true,
        last4: true,
        brand: true,
        expMonth: true,
        expYear: true,
        isDefault: true,
        bank: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: cards });
  })
);

// ─── DELETE SAVED CARD ──────────────────────────────────

router.delete(
  '/cards/:cardId',
  asyncHandler(async (req: Request, res: Response) => {
    const card = await prisma.savedCard.findFirst({
      where: { id: req.params.cardId as string, userId: req.user!.userId },
    });

    if (!card) throw new AppError('Card not found', 404);

    await prisma.savedCard.delete({ where: { id: card.id } });

    res.json({ success: true, message: 'Card removed' });
  })
);

// ─── SET DEFAULT CARD ───────────────────────────────────

router.patch(
  '/cards/:cardId/default',
  asyncHandler(async (req: Request, res: Response) => {
    // Unset all defaults
    await prisma.savedCard.updateMany({
      where: { userId: req.user!.userId },
      data: { isDefault: false },
    });

    const card = await prisma.savedCard.update({
      where: { id: req.params.cardId as string },
      data: { isDefault: true },
    });

    res.json({ success: true, data: card });
  })
);

// ─── PAYSTACK WEBHOOK ───────────────────────────────────
// Note: This route does NOT use authenticate middleware
// It should be mounted separately in the main app

export async function handlePaystackWebhook(req: Request, res: Response) {
  // Verify webhook signature
  const hash = crypto
    .createHmac('sha512', config.paystack.secretKey)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Invalid signature');
  }

  const event = req.body;

  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const payment = await prisma.payment.findUnique({
      where: { paystackRef: reference },
    });

    if (payment && payment.status !== 'SUCCESS') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'SUCCESS' },
      });

      await prisma.delivery.update({
        where: { id: payment.deliveryId },
        data: { status: 'PAID', paidAt: new Date() },
      });
    }
  }

  res.sendStatus(200);
}

// ─── PAYSTACK API HELPERS ───────────────────────────────

async function initializePaystackTransaction(
  email: string,
  amountKobo: number,
  reference: string,
  metadata: Record<string, string>
) {
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      metadata,
      currency: 'NGN',
    }),
  });

  const data: any = await response.json();
  if (!data.status) throw new AppError('Failed to initialize payment', 502);
  return data.data;
}

async function verifyPaystackTransaction(reference: string) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
      },
    }
  );

  const data: any = await response.json();
  if (!data.status) throw new AppError('Payment verification failed', 502);
  return data.data;
}

async function chargeAuthorization(
  authCode: string,
  email: string,
  amountKobo: number,
  reference: string
) {
  const response = await fetch('https://api.paystack.co/transaction/charge_authorization', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      authorization_code: authCode,
      email,
      amount: amountKobo,
      reference,
      currency: 'NGN',
    }),
  });

  const data: any = await response.json();
  return { success: data.data?.status === 'success', data: data.data };
}

export default router;
