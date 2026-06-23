import { config } from '../config';

/**
 * Send an SMS via Termii (Nigeria). Returns true when the message was handed
 * off to the provider, false when no provider is configured (so callers can
 * fall back to surfacing the code for testing).
 */
export async function sendSms(to: string, message: string): Promise<boolean> {
  if (!config.termii.apiKey) {
    console.log(`[DEV] SMS to ${to}: ${message}`);
    return false;
  }

  try {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: to.replace(/^\+/, ''),
        from: config.termii.senderId,
        sms: message,
        type: 'plain',
        channel: 'generic',
        api_key: config.termii.apiKey,
      }),
    });
    if (!res.ok) {
      console.error(`[SMS] Termii responded ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[SMS] Termii send failed:', err);
    return false;
  }
}

/** True when no SMS provider is configured — callers expose the OTP for testing. */
export const smsProviderConfigured = (): boolean => !!config.termii.apiKey;

export async function sendOtpSms(to: string, code: string): Promise<boolean> {
  return sendSms(
    to,
    `Your Tunnel Express verification code is ${code}. It expires in ${config.otp.expiryMinutes} minutes.`,
  );
}
