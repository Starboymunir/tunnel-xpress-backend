/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ─── ADMIN USER ─────────────────────────────────────
  const adminPasswordHash = await bcrypt.hash('admin123456', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@tunnelexpress.ng' },
    update: {},
    create: {
      email: 'admin@tunnelexpress.ng',
      passwordHash: adminPasswordHash,
      firstName: 'Admin',
      lastName: 'TunnelExpress',
      role: 'ADMIN',
      authProvider: 'EMAIL',
      isEmailVerified: true,
      referralCode: 'ADMIN001',
      settings: { create: {} },
      wallet: { create: {} },
    },
  });
  console.log(`  ✓ Admin user: ${admin.email}`);

  // ─── TEST CUSTOMER ──────────────────────────────────
  const customerPasswordHash = await bcrypt.hash('customer123', 12);
  const customer = await prisma.user.upsert({
    where: { email: 'customer@test.com' },
    update: {},
    create: {
      email: 'customer@test.com',
      phone: '+2348101234567',
      passwordHash: customerPasswordHash,
      firstName: 'Adeola',
      lastName: 'Johnson',
      role: 'CUSTOMER',
      authProvider: 'EMAIL',
      isEmailVerified: true,
      isPhoneVerified: true,
      referralCode: 'ADEO1234',
      settings: { create: {} },
      wallet: { create: { balance: 5000 } },
    },
  });
  console.log(`  ✓ Customer: ${customer.email}`);

  // ─── TEST RIDER ─────────────────────────────────────
  const riderPasswordHash = await bcrypt.hash('rider123456', 12);
  const rider = await prisma.user.upsert({
    where: { email: 'rider@test.com' },
    update: {},
    create: {
      email: 'rider@test.com',
      phone: '+2348109876543',
      passwordHash: riderPasswordHash,
      firstName: 'Emeka',
      lastName: 'Okafor',
      role: 'RIDER',
      authProvider: 'EMAIL',
      isEmailVerified: true,
      isPhoneVerified: true,
      referralCode: 'EMEK5678',
      settings: { create: {} },
      wallet: { create: {} },
      riderProfile: {
        create: {
          vehicleType: 'BIKE',
          plateNumber: 'LAG-123-XY',
          availability: 'ONLINE',
          isApproved: true,
          currentLat: 6.5244,
          currentLng: 3.3792,
          avgRating: 4.5,
          totalDeliveries: 42,
        },
      },
    },
  });
  console.log(`  ✓ Rider: ${rider.email}`);

  // ─── SECOND RIDER ───────────────────────────────────
  const rider2PasswordHash = await bcrypt.hash('rider123456', 12);
  const rider2 = await prisma.user.upsert({
    where: { email: 'rider2@test.com' },
    update: {},
    create: {
      email: 'rider2@test.com',
      phone: '+2348105551234',
      passwordHash: rider2PasswordHash,
      firstName: 'Chioma',
      lastName: 'Nwosu',
      role: 'RIDER',
      authProvider: 'EMAIL',
      isEmailVerified: true,
      isPhoneVerified: true,
      referralCode: 'CHIO9012',
      settings: { create: {} },
      wallet: { create: {} },
      riderProfile: {
        create: {
          vehicleType: 'CAR',
          plateNumber: 'LAG-456-AB',
          availability: 'ONLINE',
          isApproved: true,
          currentLat: 6.4541,
          currentLng: 3.3947,
          avgRating: 4.8,
          totalDeliveries: 98,
        },
      },
    },
  });
  console.log(`  ✓ Rider 2: ${rider2.email}`);

  // ─── PROMO BANNERS ──────────────────────────────────
  await prisma.promoBanner.createMany({
    data: [
      {
        title: '50% Off First Delivery!',
        subtitle: 'Use code FIRST50 on your first order',
        isActive: true,
        sortOrder: 1,
      },
      {
        title: 'Refer & Earn ₦200',
        subtitle: 'Share your code and earn on every signup',
        isActive: true,
        sortOrder: 2,
      },
      {
        title: 'Express Delivery Available',
        subtitle: 'Get your packages delivered in under 30 minutes',
        isActive: true,
        sortOrder: 3,
      },
    ],
    skipDuplicates: true,
  });
  console.log('  ✓ Promo banners created');

  // ─── COUPONS ────────────────────────────────────────
  await prisma.coupon.createMany({
    data: [
      {
        code: 'FIRST50',
        discountPercent: 50,
        maxUses: 1000,
        minOrderAmount: 500,
        expiresAt: new Date('2027-12-31'),
        isActive: true,
      },
      {
        code: 'SAVE200',
        discountFlat: 200,
        maxUses: 500,
        minOrderAmount: 1000,
        expiresAt: new Date('2027-06-30'),
        isActive: true,
      },
      {
        code: 'TUNNEL10',
        discountPercent: 10,
        maxUses: 5000,
        minOrderAmount: 300,
        expiresAt: new Date('2027-12-31'),
        isActive: true,
      },
    ],
    skipDuplicates: true,
  });
  console.log('  ✓ Coupons created');

  // ─── SAVED LOCATIONS FOR CUSTOMER ───────────────────
  await prisma.savedLocation.createMany({
    data: [
      {
        userId: customer.id,
        label: 'Home',
        address: '12 Admiralty Way, Lekki Phase 1, Lagos',
        lat: 6.4281,
        lng: 3.4219,
        isDefault: true,
      },
      {
        userId: customer.id,
        label: 'Office',
        address: '235 Ikorodu Road, Palmgrove, Lagos',
        lat: 6.5355,
        lng: 3.3723,
        isDefault: false,
      },
    ],
    skipDuplicates: true,
  });
  console.log('  ✓ Saved locations created');

  // ─── SAMPLE NOTIFICATIONS ───────────────────────────
  await prisma.notification.createMany({
    data: [
      {
        userId: customer.id,
        type: 'PROMO',
        title: 'Welcome to Tunnel Express!',
        body: 'Use code FIRST50 for 50% off your first delivery.',
      },
      {
        userId: customer.id,
        type: 'SYSTEM',
        title: 'Profile Complete',
        body: 'Your account has been set up. Start sending packages now!',
        isRead: true,
      },
    ],
    skipDuplicates: true,
  });
  console.log('  ✓ Notifications created');

  // ─── ACTIVE DELIVERY FOR CUSTOMER ───────────────────
  const riderProfile = await prisma.riderProfile.findUnique({
    where: { userId: rider.id },
  });

  const activeDelivery = await prisma.delivery.upsert({
    where: { orderTag: 'ORD001' },
    update: {
      status: 'IN_TRANSIT',
      riderId: riderProfile!.id,
      pickupAddress: '12 Admiralty Way, Lekki Phase 1, Lagos',
      pickupLat: 6.4281,
      pickupLng: 3.4219,
      pickupContactName: 'Adeola Johnson',
      pickupContactPhone: '+2348101234567',
      pickupNote: 'Ground floor reception',
      dropoffAddress: '25 Herbert Macaulay Way, Yaba, Lagos',
      dropoffLat: 6.5158,
      dropoffLng: 3.3752,
      dropoffContactName: 'Tunde Bakare',
      dropoffContactPhone: '+2348051234567',
      dropoffNote: 'Office on 3rd floor',
      packageName: 'Electronics Parcel',
      packageDescription: 'Laptop and accessories in padded box',
      riderType: 'BIKE',
      specialInstructions: 'Handle with care, fragile items',
      distanceKm: 12.5,
      baseFee: 500,
      perKmFee: 100,
      surgeMultiplier: 1.0,
      totalFee: 1750,
      discountAmount: 0,
      paidAt: new Date(),
      assignedAt: new Date(),
      pickedUpAt: new Date(),
      estimatedMinutes: 25,
      liveRiderLat: 6.4850,
      liveRiderLng: 3.3900,
    },
    create: {
      orderTag: 'ORD001',
      customerId: customer.id,
      riderId: riderProfile!.id,
      status: 'IN_TRANSIT',

      // Pickup
      pickupAddress: '12 Admiralty Way, Lekki Phase 1, Lagos',
      pickupLat: 6.4281,
      pickupLng: 3.4219,
      pickupContactName: 'Adeola Johnson',
      pickupContactPhone: '+2348101234567',
      pickupNote: 'Ground floor reception',

      // Dropoff
      dropoffAddress: '25 Herbert Macaulay Way, Yaba, Lagos',
      dropoffLat: 6.5158,
      dropoffLng: 3.3752,
      dropoffContactName: 'Tunde Bakare',
      dropoffContactPhone: '+2348051234567',
      dropoffNote: 'Office on 3rd floor',

      // Package
      packageName: 'Electronics Parcel',
      packageDescription: 'Laptop and accessories in padded box',
      riderType: 'BIKE',
      specialInstructions: 'Handle with care, fragile items',

      // Pricing
      distanceKm: 12.5,
      baseFee: 500,
      perKmFee: 100,
      surgeMultiplier: 1.0,
      totalFee: 1750,
      discountAmount: 0,

      // Timestamps
      paidAt: new Date(),
      assignedAt: new Date(),
      pickedUpAt: new Date(),

      // Tracking
      estimatedMinutes: 25,
      liveRiderLat: 6.4850,
      liveRiderLng: 3.3900,
    },
  });

  // Create payment for the delivery
  await prisma.payment.upsert({
    where: { deliveryId: activeDelivery.id },
    update: {},
    create: {
      deliveryId: activeDelivery.id,
      userId: customer.id,
      amount: 1750,
      currency: 'NGN',
      method: 'WALLET',
      status: 'SUCCESS',
      paystackRef: 'SEED_PAY_001',
    },
  });
  console.log('  ✓ Active delivery (IN_TRANSIT) created for customer');

  console.log('\n✅ Seed completed successfully!');
  console.log('\n  Test accounts:');
  console.log('  ─────────────────────────────────');
  console.log('  Admin:    admin@tunnelexpress.ng / admin123456');
  console.log('  Customer: customer@test.com / customer123');
  console.log('  Rider:    rider@test.com / rider123456');
  console.log('  Rider 2:  rider2@test.com / rider123456');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
