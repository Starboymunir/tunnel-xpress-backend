// Dev/demo helper: progress a paid delivery through its lifecycle on a timer
// so the customer app can be tested without a rider device. Activated only
// when there is no Paystack secret (fake payment mode).
import prisma from './prisma';

const SCHEDULE: Array<{ delayMs: number; status: 'FINDING_RIDER' | 'RIDER_ASSIGNED' | 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED' }> = [
  { delayMs: 2_000, status: 'FINDING_RIDER' },
  { delayMs: 4_000, status: 'RIDER_ASSIGNED' },
  { delayMs: 7_000, status: 'PICKED_UP' },
  { delayMs: 10_000, status: 'IN_TRANSIT' },
  { delayMs: 14_000, status: 'DELIVERED' },
];

const inFlight = new Set<string>();

async function pickAvailableRiderId(): Promise<string | null> {
  try {
    const rider = await prisma.riderProfile.findFirst({
      where: { isApproved: true, availability: 'ONLINE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (rider) return rider.id;
    // Fallback: any rider profile, even if availability isn't online
    const any = await prisma.riderProfile.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return any?.id ?? null;
  } catch {
    return null;
  }
}

export function simulateDeliveryProgression(deliveryId: string) {
  if (inFlight.has(deliveryId)) return;
  inFlight.add(deliveryId);

  let cancelled = false;
  let assignedRiderId: string | null = null;

  const run = async () => {
    for (const step of SCHEDULE) {
      await new Promise((r) => setTimeout(r, step.delayMs));
      if (cancelled) return;

      try {
        const current = await prisma.delivery.findUnique({
          where: { id: deliveryId },
          select: { status: true, riderId: true },
        });
        if (!current) return;
        if (current.status === 'CANCELLED' || current.status === 'DELIVERED' || current.status === 'FAILED') return;

        const data: any = { status: step.status };

        if (step.status === 'RIDER_ASSIGNED' && !current.riderId) {
          if (!assignedRiderId) assignedRiderId = await pickAvailableRiderId();
          if (assignedRiderId) {
            data.riderId = assignedRiderId;
            data.acceptedAt = new Date();
            // eslint-disable-next-line no-console
            console.log(`[devSimulator] ${deliveryId} assigning rider ${assignedRiderId}`);
          }
        }
        if (step.status === 'PICKED_UP') data.pickedUpAt = new Date();
        if (step.status === 'DELIVERED') data.deliveredAt = new Date();

        await prisma.delivery.update({ where: { id: deliveryId }, data });
        // eslint-disable-next-line no-console
        console.log(`[devSimulator] ${deliveryId} → ${step.status}${current.riderId ? ` (riderId=${current.riderId})` : ''}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[devSimulator] step failed', err);
      }
    }
  };

  run().finally(() => {
    inFlight.delete(deliveryId);
  });
}
