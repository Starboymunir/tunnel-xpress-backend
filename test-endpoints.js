/**
 * Comprehensive endpoint test for Tunnel Express API
 */
const BASE = 'http://localhost:3000/api';
let token = null;
let refreshToken = null;
let pass = 0;
let fail = 0;

async function t(label, url, options = {}) {
  const { method = 'GET', body, auth = true, noJson = false } = options;
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (data.success || res.ok) {
      console.log(`✅ ${label}`);
      pass++;
      return data;
    } else {
      console.log(`❌ ${label} -> ${data.message || JSON.stringify(data)}`);
      fail++;
      return data;
    }
  } catch (e) {
    console.log(`❌ ${label} -> ${e.message}`);
    fail++;
    return null;
  }
}

async function run() {
  console.log('\n=== Tunnel Express API Tests ===\n');

  // HEALTH
  await t('GET /health', `${BASE}/health`, { auth: false });

  // AUTH - Login
  const lr = await t('POST /auth/login/email', `${BASE}/auth/login/email`, {
    method: 'POST', auth: false,
    body: { email: 'customer@test.com', password: 'customer123' }
  });
  if (lr?.data?.accessToken) {
    token = lr.data.accessToken;
    refreshToken = lr.data.refreshToken;
  }

  // AUTH - Refresh
  await t('POST /auth/refresh-token', `${BASE}/auth/refresh-token`, {
    method: 'POST', auth: false,
    body: { refreshToken }
  });

  // AUTH - Get me
  await t('GET /auth/me', `${BASE}/auth/me`);

  // AUTH - Resend OTP
  await t('POST /auth/resend-otp', `${BASE}/auth/resend-otp`, {
    method: 'POST', body: { identifier: 'customer@test.com' }
  });

  // AUTH - Verify OTP (will fail - code invalid, but endpoint should respond)
  await t('POST /auth/verify-otp (invalid code)', `${BASE}/auth/verify-otp`, {
    method: 'POST', body: { identifier: 'customer@test.com', code: '000000' }
  });

  // AUTH - Forgot password
  await t('POST /auth/forgot-password', `${BASE}/auth/forgot-password`, {
    method: 'POST', auth: false,
    body: { email: 'customer@test.com' }
  });

  // AUTH - Register (new user)
  const ts = Date.now();
  await t('POST /auth/register/email', `${BASE}/auth/register/email`, {
    method: 'POST', auth: false,
    body: { email: `test${ts}@test.com`, password: 'Test1234!', firstName: 'Test', lastName: 'User' }
  });

  // USERS
  await t('GET /users', `${BASE}/users`);
  await t('PATCH /users', `${BASE}/users`, { method: 'PATCH', body: { firstName: 'Customer' } });
  await t('PATCH /users/avatar', `${BASE}/users/avatar`, { method: 'PATCH', body: { avatarUrl: 'https://example.com/a.jpg' } });
  await t('GET /users/settings', `${BASE}/users/settings`);
  await t('PATCH /users/settings', `${BASE}/users/settings`, { method: 'PATCH', body: { pushNotifications: true } });

  // DELIVERIES
  await t('GET /deliveries', `${BASE}/deliveries`);
  const est = await t('POST /deliveries/calculate-fee', `${BASE}/deliveries/calculate-fee`, {
    method: 'POST', body: { pickupLat: 6.4541, pickupLng: 3.4215, dropoffLat: 6.6018, dropoffLng: 3.3515, riderType: 'BIKE' }
  });
  const newDel = await t('POST /deliveries', `${BASE}/deliveries`, {
    method: 'POST', body: {
      packageName: 'Test Package', pickupAddress: 'Test Pickup',
      pickupLat: 6.4541, pickupLng: 3.4215,
      dropoffAddress: 'Test Dropoff', dropoffLat: 6.6018, dropoffLng: 3.3515,
      riderType: 'BIKE', pickupContactName: 'John', dropoffContactName: 'Jane'
    }
  });
  const delId = newDel?.data?.id || null;
  if (delId) {
    await t(`GET /deliveries/${delId}`, `${BASE}/deliveries/${delId}`);
    await t(`GET /deliveries/${delId}/tracking`, `${BASE}/deliveries/${delId}/tracking`);
  } else {
    console.log('⚠️  Skipping delivery-specific tests (no delivery created)');
  }

  // PAYMENTS
  await t('GET /payments/cards', `${BASE}/payments/cards`);
  let payRef = null;
  if (delId) {
    const initPay = await t('POST /payments/initialize', `${BASE}/payments/initialize`, {
      method: 'POST', body: { deliveryId: delId, method: 'CARD' }
    });
    payRef = initPay?.data?.reference;
    if (payRef) {
      await t('POST /payments/verify', `${BASE}/payments/verify`, {
        method: 'POST', body: { reference: payRef }
      });
    }
  }
  await t('DELETE /payments/cards/invalid-id (404 expected)', `${BASE}/payments/cards/00000000-0000-0000-0000-000000000000`, { method: 'DELETE' });

  // NOTIFICATIONS
  await t('GET /notifications', `${BASE}/notifications`);
  await t('PATCH /notifications/read-all', `${BASE}/notifications/read-all`, { method: 'PATCH' });

  // REFERRALS
  await t('GET /referrals', `${BASE}/referrals`);
  await t('GET /referrals/history', `${BASE}/referrals/history`);
  await t('POST /referrals/apply (invalid code, 404 expected)', `${BASE}/referrals/apply`, {
    method: 'POST', body: { code: 'BADCODE' }
  });

  // LOCATIONS
  await t('GET /locations', `${BASE}/locations`);
  const savedLoc = await t('POST /locations', `${BASE}/locations`, {
    method: 'POST', body: { label: 'Home', address: '123 Lagos St', lat: 6.5244, lng: 3.3792 }
  });
  const locId = savedLoc?.data?.id;
  if (locId) {
    await t(`PATCH /locations/${locId}`, `${BASE}/locations/${locId}`, {
      method: 'PATCH', body: { label: 'Home Updated' }
    });
    await t(`DELETE /locations/${locId}`, `${BASE}/locations/${locId}`, { method: 'DELETE' });
  }

  // SUPPORT
  await t('GET /support', `${BASE}/support`);
  const chatRes = await t('POST /support', `${BASE}/support`, {
    method: 'POST', body: { subject: 'Test Issue', message: 'Hello support team' }
  });
  const chatId = chatRes?.data?.id;
  if (chatId) {
    await t(`GET /support/${chatId}/messages`, `${BASE}/support/${chatId}/messages`);
    await t(`POST /support/${chatId}/messages`, `${BASE}/support/${chatId}/messages`, {
      method: 'POST', body: { content: 'Follow up message' }
    });
  }

  // PROMOS
  await t('GET /promos/banners', `${BASE}/promos/banners`, { auth: false });
  await t('POST /promos/coupons/apply (invalid, 404 expected)', `${BASE}/promos/coupons/apply`, {
    method: 'POST', body: { code: 'BADCOUPON', orderAmount: 5000 }
  });

  // Delivery cancel (after other tests so we have a delivery)
  if (delId) {
    await t(`POST /deliveries/${delId}/cancel`, `${BASE}/deliveries/${delId}/cancel`, {
      method: 'POST', body: { reason: 'Test cancellation' }
    });
  }

  // Rate delivery (will fail since it needs to be delivered, but should respond)
  if (delId) {
    await t(`POST /deliveries/${delId}/rate (status check expected error)`, `${BASE}/deliveries/${delId}/rate`, {
      method: 'POST', body: { score: 5, comment: 'Great service' }
    });
  }

  console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===\n`);
}

run().catch(console.error);
