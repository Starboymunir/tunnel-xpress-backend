import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createChatSchema, sendMessageSchema } from '../schemas';

const router = Router();

router.use(authenticate);

// ─── FAQS + SUPPORT CONFIG ──────────────────────────────
const FAQS = [
  { id: 'contact', question: 'How do I contact customer support?', answer: 'Tap "Live Chat" to message an agent in real time, or "Call Now" to reach our 24/7 hotline. You can also start a chat from the Support screen at any time.' },
  { id: 'become-rider', question: 'How do I become a rider on Tunnel Express?', answer: 'Sign up, choose "Rider", then complete identity verification: personal details, a valid government ID, a selfie, your rider permit, and your vehicle details. Once approved you can go online and start accepting deliveries.' },
  { id: 'requests', question: 'How do I get delivery requests?', answer: 'Toggle "Go Online" on your home screen. While online and verified, nearby paid orders appear in your requests. Accept one to start the trip; declining a request hides it from you.' },
  { id: 'earn-paid', question: 'How do I earn and get paid?', answer: 'You earn a commission on every completed delivery. Earnings collect under Earnings & Payouts. Add a verified bank account, then tap "Request payout" to move your pending earnings to your bank.' },
  { id: 'documents', question: 'What documents are required for verification?', answer: 'A valid government-issued ID (NIN, Voter\'s card, Driver\'s license, or International Passport), a clear selfie, your rider permit/licence, and your vehicle plate details.' },
  { id: 'issue', question: 'What if there\'s an issue during a delivery?', answer: 'Use the in-app call or chat to reach the customer. If you can\'t resolve it, contact support via Live Chat or the hotline and we\'ll help right away.' },
  { id: 'code', question: 'Why do I need a code to complete a delivery?', answer: 'At drop-off the customer gives you a unique code shown in their app. Entering it confirms the package reached the right person and releases your earning for the trip.' },
];

router.get(
  '/faqs',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: FAQS });
  })
);

router.get(
  '/config',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        phone: process.env.SUPPORT_PHONE || '+2348000000000',
        email: process.env.SUPPORT_EMAIL || 'support@tunnel-xpress.com',
        hours: '24/7',
      },
    });
  })
);

// ─── LIST MY SUPPORT CHATS ─────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const chats = await prisma.supportChat.findMany({
      where: { userId: req.user!.userId },
      include: {
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { content: true, createdAt: true, isAgent: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ success: true, data: chats });
  })
);

// ─── CREATE SUPPORT CHAT ────────────────────────────────

router.post(
  '/',
  validate(createChatSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { subject, message } = req.body;

    const chat = await prisma.supportChat.create({
      data: {
        userId: req.user!.userId,
        subject,
        messages: {
          create: {
            senderId: req.user!.userId,
            content: message,
            isAgent: false,
          },
        },
      },
      include: {
        messages: true,
      },
    });

    res.status(201).json({ success: true, data: chat });
  })
);

// ─── GET CHAT MESSAGES ──────────────────────────────────

router.get(
  '/:chatId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const chat = await prisma.supportChat.findFirst({
      where: { id: req.params.chatId as string, userId: req.user!.userId },
    });

    if (!chat) throw new AppError('Chat not found', 404);

    const messages = await prisma.supportMessage.findMany({
      where: { chatId: req.params.chatId as string },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: { chat, messages } });
  })
);

// ─── SEND MESSAGE ───────────────────────────────────────

router.post(
  '/:chatId/messages',
  validate(sendMessageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const chat = await prisma.supportChat.findFirst({
      where: { id: req.params.chatId as string, userId: req.user!.userId },
    });

    if (!chat) throw new AppError('Chat not found', 404);
    if (chat.status === 'CLOSED') {
      throw new AppError('This chat has been closed', 400);
    }

    const message = await prisma.supportMessage.create({
      data: {
        chatId: req.params.chatId as string,
        senderId: req.user!.userId,
        content: req.body.content,
        isAgent: false,
      },
    });

    // Update chat timestamp
    await prisma.supportChat.update({
      where: { id: req.params.chatId as string },
      data: { updatedAt: new Date() },
    });

    res.status(201).json({ success: true, data: message });
  })
);

export default router;
