import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createChatSchema, sendMessageSchema } from '../schemas';

const router = Router();

router.use(authenticate);

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
