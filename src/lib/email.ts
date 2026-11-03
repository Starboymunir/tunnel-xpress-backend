import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transporter;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  // ZeptoMail sends over HTTPS, so it works on hosts that block outbound SMTP
  // ports (e.g. Render's free plan). Preferred whenever its token is set.
  if (process.env.ZEPTOMAIL_TOKEN) return sendViaZeptoMail(opts);

  const t = getTransporter();
  if (!t) {
    console.warn('[email] No email provider configured. Skipping send to', opts.to);
    return { sent: false, reason: 'smtp_not_configured' };
  }
  try {
    await t.sendMail({
      from: config.smtp.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return { sent: true };
  } catch (err: any) {
    console.error('[email/smtp] send failed:', err?.message || err);
    return { sent: false, reason: err?.message || 'smtp_failed' };
  }
}

function parseFrom(from: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim() || 'Tunnel Express', email: m[2].trim() } : { name: 'Tunnel Express', email: from.trim() };
}

// Accepts the token with or without the "Zoho-enczapikey " prefix ZeptoMail shows it with.
function zeptoAuth(): string {
  const t = (process.env.ZEPTOMAIL_TOKEN as string).trim();
  return t.startsWith('Zoho-enczapikey') ? t : `Zoho-enczapikey ${t}`;
}

// US datacenter by default; set ZEPTOMAIL_HOST for others (api.zeptomail.eu, api.zeptomail.in).
const zeptoUrl = () => `https://${process.env.ZEPTOMAIL_HOST || 'api.zeptomail.com'}/v1.1/email`;

async function sendViaZeptoMail(opts: { to: string; subject: string; text: string; html?: string }): Promise<{ sent: boolean; reason?: string }> {
  try {
    const from = parseFrom(process.env.ZEPTOMAIL_FROM || config.smtp.from);
    const res = await fetch(zeptoUrl(), {
      method: 'POST',
      headers: { Authorization: zeptoAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        from: { address: from.email, name: from.name },
        to: [{ email_address: { address: opts.to } }],
        subject: opts.subject,
        textbody: opts.text,
        ...(opts.html ? { htmlbody: opts.html } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[email/zeptomail] send failed:', res.status, body);
      return { sent: false, reason: `zeptomail_${res.status}` };
    }
    return { sent: true };
  } catch (err: any) {
    console.error('[email/zeptomail] send failed:', err?.message || err);
    return { sent: false, reason: err?.message || 'zeptomail_failed' };
  }
}

export async function sendOtpEmail(to: string, code: string) {
  const subject = 'Your Tunnel Express verification code';
  const text = `Your verification code is ${code}. It expires in ${config.otp.expiryMinutes} minutes.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f7f5ff;border-radius:12px;">
      <h2 style="color:#3a1f6e;margin:0 0 12px;">Verify your email</h2>
      <p style="color:#333;font-size:14px;line-height:1.5;margin:0 0 16px;">
        Use the code below to verify your Tunnel Express account. It expires in ${config.otp.expiryMinutes} minutes.
      </p>
      <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#3a1f6e;background:#fff;padding:16px 24px;border-radius:8px;text-align:center;">
        ${code}
      </div>
      <p style="color:#666;font-size:12px;margin:16px 0 0;">If you did not request this code, you can safely ignore this email.</p>
    </div>
  `;
  return sendEmail({ to, subject, text, html });
}

/** Connects to the SMTP server without sending anything — for the email health check. */
export async function verifyEmailTransport(): Promise<{ configured: boolean; ok: boolean; provider?: string; error?: string }> {
  if (process.env.ZEPTOMAIL_TOKEN) {
    // ZeptoMail has no read-only endpoint for send tokens, so post an empty
    // message: a bad token gets 401/403, a good one only a validation error.
    try {
      const res = await fetch(zeptoUrl(), {
        method: 'POST',
        headers: { Authorization: zeptoAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      return res.status === 401 || res.status === 403
        ? { configured: true, ok: false, provider: 'zeptomail', error: `zeptomail_${res.status}: ${await res.text()}` }
        : { configured: true, ok: true, provider: 'zeptomail' };
    } catch (err: any) {
      return { configured: true, ok: false, provider: 'zeptomail', error: err?.message || String(err) };
    }
  }
  const t = getTransporter();
  if (!t) return { configured: false, ok: false, error: 'smtp_not_configured' };
  try {
    await Promise.race([
      t.verify(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SMTP connection timed out after 15s')), 15000)),
    ]);
    return { configured: true, ok: true, provider: 'smtp' };
  } catch (err: any) {
    return { configured: true, ok: false, error: err?.message || String(err) };
  }
}
