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
  const t = getTransporter();
  if (!t) {
    console.warn('[email] SMTP not configured. Skipping send to', opts.to);
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
