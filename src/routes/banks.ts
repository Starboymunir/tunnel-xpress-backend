import { Router, Request, Response } from 'express';
import { config } from '../config';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// A small set of common Nigerian banks, used when Paystack isn't configured.
const FALLBACK_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda Bank' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
  { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
];

// ─── LIST BANKS ─────────────────────────────────────────
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    if (config.paystack.secretKey) {
      try {
        const r = await fetch('https://api.paystack.co/bank?currency=NGN&perPage=100', {
          headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
        });
        const j: any = await r.json();
        if (j?.status && Array.isArray(j.data)) {
          const banks = j.data.map((b: any) => ({ code: b.code, name: b.name }));
          return res.json({ success: true, data: banks });
        }
      } catch {
        /* fall through to fallback list */
      }
    }
    res.json({ success: true, data: FALLBACK_BANKS });
  })
);

// ─── RESOLVE ACCOUNT NAME (name enquiry) ────────────────
router.post(
  '/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    const accountNumber = String(req.body?.accountNumber || '');
    const bankCode = String(req.body?.bankCode || '');
    if (!/^\d{10}$/.test(accountNumber) || !bankCode) {
      throw new AppError('A valid 10-digit account number and bank are required', 400);
    }

    if (config.paystack.secretKey) {
      try {
        const r = await fetch(
          `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
          { headers: { Authorization: `Bearer ${config.paystack.secretKey}` } }
        );
        const j: any = await r.json();
        if (j?.status && j.data?.account_name) {
          return res.json({ success: true, data: { accountName: j.data.account_name } });
        }
        return res.status(422).json({ success: false, error: 'resolve_failed', message: j?.message || 'Could not resolve this account.' });
      } catch {
        /* fall through to dev fallback */
      }
    }

    // Dev fallback (no Paystack): echo the rider's own name so the flow is testable.
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { firstName: true, lastName: true } });
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').toUpperCase() || 'ACCOUNT HOLDER';
    res.json({ success: true, data: { accountName: name } });
  })
);

export default router;
