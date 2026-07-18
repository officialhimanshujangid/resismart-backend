import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { FinancePolicy } from '../models/finance-policy.model';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { resolveGateway } from '../services/payment-gateway-resolver.service';
import { handleFinanceWebhook } from '../services/finance-webhook.service';
import { encryptSecret } from '../utils/finance-crypto.util';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

/** GET /finance/society/settlement — current mode + masked config. */
export const getSettlement = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const policy = await getOrCreatePolicy(societyId, req.user!.userId, req.user!.userName || 'Admin');
    const s = policy.settlement;
    res.json({
      mode: s.mode,
      upiId: s.upiId || '',
      ownKeys: s.ownKeys?.keyId ? { keyId: s.ownKeys.keyId, hasSecret: !!s.ownKeys.keySecretEnc, hasWebhookSecret: !!s.ownKeys.webhookSecretEnc } : null,
      payoutBank: s.payoutBank?.last4 ? { accountName: s.payoutBank.accountName, last4: s.payoutBank.last4, ifsc: s.payoutBank.ifsc, bankName: s.payoutBank.bankName } : null,
      webhookUrl: s.mode === 'OWN_KEYS' ? `${req.protocol}://${req.get('host')}/api/v1/webhooks/razorpay/society/${societyId}` : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** PUT /finance/society/settlement — set mode + the fields that mode requires. */
export const updateSettlement = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const { mode, upiId, keyId, keySecret, webhookSecret, payoutAccountName, payoutAccountNumber, payoutIfsc, payoutBankName } = req.body;

    const policy = await getOrCreatePolicy(societyId, req.user!.userId, req.user!.userName || 'Admin');
    const s = policy.settlement;

    // Per-mode required-field enforcement (no half-configured gateway).
    if (mode === 'OWN_KEYS') {
      s.ownKeys = s.ownKeys || {} as any;
      const finalKeyId = keyId || s.ownKeys!.keyId;
      if (!finalKeyId) throw new Error('Razorpay Key ID is required for your-own-keys mode');
      if (!keySecret && !s.ownKeys!.keySecretEnc) throw new Error('Razorpay Key Secret is required');
      if (!webhookSecret && !s.ownKeys!.webhookSecretEnc) throw new Error('Razorpay Webhook Secret is required');
      if (keyId) s.ownKeys!.keyId = keyId;
      if (keySecret) { const e = encryptSecret(keySecret); s.ownKeys!.keySecretEnc = e.ct; s.ownKeys!.keySecretIv = e.iv; s.ownKeys!.keySecretTag = e.tag; }
      if (webhookSecret) { const e = encryptSecret(webhookSecret); s.ownKeys!.webhookSecretEnc = e.ct; s.ownKeys!.webhookSecretIv = e.iv; s.ownKeys!.webhookSecretTag = e.tag; }
    } else if (mode === 'PLATFORM_COLLECT_PAYOUT') {
      const hasSaved = !!s.payoutBank?.last4;
      if (!hasSaved && (!payoutAccountNumber || !payoutIfsc || !payoutAccountName || !payoutBankName)) {
        throw new Error('Payout bank account (name, number, IFSC, bank) is required so collected money can be settled to your society');
      }
      if (payoutAccountNumber) {
        const e = encryptSecret(payoutAccountNumber);
        s.payoutBank = { accountName: payoutAccountName, ifsc: payoutIfsc, bankName: payoutBankName, accountNumberEnc: e.ct, accountNumberIv: e.iv, accountNumberTag: e.tag, last4: payoutAccountNumber.slice(-4) } as any;
      } else if (payoutAccountName || payoutIfsc || payoutBankName) {
        s.payoutBank = { ...(s.payoutBank || {}), accountName: payoutAccountName ?? s.payoutBank?.accountName, ifsc: payoutIfsc ?? s.payoutBank?.ifsc, bankName: payoutBankName ?? s.payoutBank?.bankName } as any;
      }
    }

    s.mode = mode;
    if (upiId !== undefined) s.upiId = upiId;

    policy.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    policy.updatedByName = req.user!.userName || 'Admin';
    policy.markModified('settlement');
    await policy.save();

    auditFinance(req, 'FINANCE_UPDATE_SETTLEMENT', 'FinancePolicy', policy._id.toString(), { newValues: { mode: s.mode } });
    res.json({ message: 'Settlement settings updated', mode: s.mode });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

/** POST /api/v1/webhooks/razorpay/society/:societyId — per-society (OWN_KEYS) webhook. */
export const societyRazorpayWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const { societyId } = req.params;
    const signature = req.headers['x-razorpay-signature'] as string;
    const rawBody: Buffer = (req as any).body; // express.raw
    const gateway = await resolveGateway(societyId);
    if (!gateway.webhookSecret) { res.status(400).json({ error: 'No webhook secret configured' }); return; }
    await handleFinanceWebhook(societyId, rawBody, signature, gateway.webhookSecret);
    res.status(200).json({ received: true });
  } catch (e: any) {
    logger.error(`[society-webhook] ${req.params.societyId}: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
};
