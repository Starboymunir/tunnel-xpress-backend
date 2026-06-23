import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import prisma from '../lib/prisma';
import { AuthPayload } from '../middleware/auth';

let io: SocketIOServer;

export function initializeSocketIO(httpServer: HttpServer) {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.cors.origin,
      methods: ['GET', 'POST'],
    },
  });

  // Authenticate socket connections
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, config.jwt.secret) as AuthPayload;
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, role: true, isActive: true },
      });

      if (!user || !user.isActive) {
        return next(new Error('User not found'));
      }

      socket.data.user = { userId: user.id, role: user.role };
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.user.userId;
    const role = socket.data.user.role;

    // Join personal room for notifications
    socket.join(`user:${userId}`);
    // Riders also join a shared room so new orders can be broadcast to them
    if (role === 'RIDER') socket.join('riders');

    console.log(`[Socket] ${role} ${userId} connected`);

    // ─── CUSTOMER: Subscribe to delivery tracking ─────
    socket.on('delivery:subscribe', (deliveryId: string) => {
      socket.join(`delivery:${deliveryId}`);
      console.log(`[Socket] ${userId} subscribed to delivery:${deliveryId}`);
    });

    socket.on('delivery:unsubscribe', (deliveryId: string) => {
      socket.leave(`delivery:${deliveryId}`);
    });

    // Relay typing indicator to the other party in the delivery room.
    socket.on('delivery:typing', (deliveryId: string) => {
      socket.to(`delivery:${deliveryId}`).emit('delivery:typing', { deliveryId, userId });
    });

    // ─── RIDER: Update live location ─────────────────
    socket.on('rider:location', async (data: { lat: number; lng: number; deliveryId?: string }) => {
      if (role !== 'RIDER') return;

      const { lat, lng, deliveryId } = data;

      // Update rider profile location
      await prisma.riderProfile.updateMany({
        where: { userId },
        data: { currentLat: lat, currentLng: lng, lastLocationAt: new Date() },
      });

      // If on an active delivery, broadcast to the delivery room
      if (deliveryId) {
        await prisma.delivery.update({
          where: { id: deliveryId },
          data: { liveRiderLat: lat, liveRiderLng: lng },
        });

        io.to(`delivery:${deliveryId}`).emit('rider:locationUpdate', {
          deliveryId,
          lat,
          lng,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // ─── RIDER: Update availability ──────────────────
    socket.on('rider:availability', async (status: 'ONLINE' | 'OFFLINE' | 'BUSY') => {
      if (role !== 'RIDER') return;

      await prisma.riderProfile.updateMany({
        where: { userId },
        data: { availability: status },
      });

      console.log(`[Socket] Rider ${userId} availability: ${status}`);
    });

    // ─── RIDER: Accept delivery ──────────────────────
    socket.on('rider:acceptDelivery', async (deliveryId: string) => {
      if (role !== 'RIDER') return;

      const riderProfile = await prisma.riderProfile.findUnique({
        where: { userId },
      });
      if (!riderProfile) return;

      const delivery = await prisma.delivery.findUnique({
        where: { id: deliveryId },
      });

      if (!delivery || delivery.status !== 'FINDING_RIDER') {
        socket.emit('rider:acceptError', { message: 'Delivery no longer available' });
        return;
      }

      // Assign rider
      const updated = await prisma.delivery.update({
        where: { id: deliveryId },
        data: {
          riderId: riderProfile.id,
          status: 'RIDER_ASSIGNED',
          assignedAt: new Date(),
        },
        include: {
          rider: {
            select: {
              vehicleType: true,
              plateNumber: true,
              avgRating: true,
              user: { select: { firstName: true, lastName: true, phone: true, avatarUrl: true } },
            },
          },
        },
      });

      await prisma.riderProfile.update({
        where: { id: riderProfile.id },
        data: { availability: 'BUSY' },
      });

      // Notify customer
      io.to(`delivery:${deliveryId}`).emit('delivery:statusUpdate', {
        deliveryId,
        status: 'RIDER_ASSIGNED',
        rider: updated.rider,
      });

      io.to(`user:${delivery.customerId}`).emit('notification', {
        type: 'RIDER',
        title: 'Rider Assigned',
        body: `${updated.rider?.user.firstName} is on the way to pick up your package.`,
      });

      socket.emit('rider:acceptSuccess', { deliveryId });
    });

    // ─── RIDER: Confirm pickup ───────────────────────
    socket.on('rider:confirmPickup', async (deliveryId: string) => {
      if (role !== 'RIDER') return;

      const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
      if (!delivery || delivery.status !== 'RIDER_ASSIGNED') return;

      await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'PICKED_UP', pickedUpAt: new Date() },
      });

      io.to(`delivery:${deliveryId}`).emit('delivery:statusUpdate', {
        deliveryId,
        status: 'PICKED_UP',
      });

      io.to(`user:${delivery.customerId}`).emit('notification', {
        type: 'ORDER',
        title: 'Package Picked Up',
        body: 'Your package has been picked up and is on its way!',
      });
    });

    // ─── RIDER: Start transit ────────────────────────
    socket.on('rider:startTransit', async (deliveryId: string) => {
      if (role !== 'RIDER') return;

      await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'IN_TRANSIT' },
      });

      io.to(`delivery:${deliveryId}`).emit('delivery:statusUpdate', {
        deliveryId,
        status: 'IN_TRANSIT',
      });
    });

    // ─── RIDER: Confirm delivery ─────────────────────
    socket.on('rider:confirmDelivery', async (deliveryId: string) => {
      if (role !== 'RIDER') return;

      const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
      if (!delivery) return;

      await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });

      const riderProfile = await prisma.riderProfile.findUnique({ where: { userId } });
      if (riderProfile) {
        await prisma.riderProfile.update({
          where: { id: riderProfile.id },
          data: {
            availability: 'ONLINE',
            totalDeliveries: { increment: 1 },
          },
        });
      }

      io.to(`delivery:${deliveryId}`).emit('delivery:statusUpdate', {
        deliveryId,
        status: 'DELIVERED',
      });

      io.to(`user:${delivery.customerId}`).emit('notification', {
        type: 'ORDER',
        title: 'Package Delivered!',
        body: 'Your package has been delivered successfully.',
      });
    });

    // ─── DISCONNECT ──────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] ${role} ${userId} disconnected`);
    });
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

// ─── HELPER: Emit delivery status to customer ───────────

export async function emitDeliveryStatus(deliveryId: string, status: string, extraData?: any) {
  if (!io) return;
  io.to(`delivery:${deliveryId}`).emit('delivery:statusUpdate', {
    deliveryId,
    status,
    ...extraData,
  });
}

// ─── HELPER: Emit a new chat message to a delivery room ─

export function emitDeliveryMessage(deliveryId: string, message: any) {
  if (!io) return;
  io.to(`delivery:${deliveryId}`).emit('delivery:message', message);
}

// ─── HELPER: Broadcast to all connected riders ──────────

export function emitToRiders(event: string, data: any) {
  if (!io) return;
  io.to('riders').emit(event, data);
}

// ─── HELPER: Send notification to specific user ─────────

export async function emitNotification(userId: string, notification: {
  type: string;
  title: string;
  body: string;
  data?: any;
}) {
  // Persist so it shows up in the notifications list (and survives reconnect).
  let saved: any = null;
  try {
    saved = await prisma.notification.create({
      data: {
        userId,
        type: notification.type as any,
        title: notification.title,
        body: notification.body,
        data: notification.data ?? undefined,
      },
    });
  } catch {}
  if (!io) return;
  io.to(`user:${userId}`).emit('notification', saved ?? notification);
}

// ─── RIDER MATCHING: notify available riders of a new job ───────
// Persists a notification per eligible rider (so it shows in the bell + list)
// AND emits it in real time. Riders without a known location still get notified;
// when location is known we rank closest-first.

export async function notifyRidersOfNewDelivery(deliveryId: string) {
  const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.status !== 'FINDING_RIDER') return;

  const riders = await prisma.riderProfile.findMany({
    where: {
      availability: 'ONLINE',
      isApproved: true,
      vehicleType: delivery.riderType,
    },
    select: { id: true, userId: true, currentLat: true, currentLng: true },
    take: 50,
  });

  const declined = new Set(delivery.declinedRiderIds ?? []);
  const ranked = riders
    .filter((r) => !declined.has(r.id))
    .map((r) => ({
      r,
      dist:
        r.currentLat != null && r.currentLng != null
          ? Math.hypot(r.currentLat - delivery.pickupLat, r.currentLng - delivery.pickupLng)
          : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

  const fee = Number(delivery.totalFee).toLocaleString();
  for (const { r } of ranked) {
    await emitNotification(r.userId, {
      type: 'ORDER',
      title: 'New delivery available',
      body: `${delivery.packageName || 'A package'} · ₦${fee} · ${delivery.pickupAddress} → ${delivery.dropoffAddress}`,
      data: {
        deliveryId: delivery.id,
        action: { label: 'View order', variant: 'purple', route: '/rider/orders' },
      },
    });
  }
}
