import { FinancePolicy, SettlementMode } from '../models/finance-policy.model';
import { RazorpayService } from './razorpay.service';
import { appConfig } from '../config/appConfig';
import { decryptSecret } from '../utils/finance-crypto.util';

export interface ResolvedGateway {
  mode: SettlementMode;
  online: boolean;                 // whether online payment is available
  webhookSecret: string;           // secret to verify webhooks for this society
  createLink: (opts: {
    amountPaise: number;
    description: string;
    customer: { name?: string; email?: string; contact?: string };
    notes?: Record<string, string>;
  }) => Promise<{ id: string; short_url: string }>;
}

/**
 * Resolve how a society collects online payments, per its FinancePolicy.settlement:
 *  - OFFLINE_ONLY: no gateway (record-keeping only)
 *  - OWN_KEYS: society's own Razorpay account — money never touches the platform;
 *    webhooks verified with the society's own secret at /webhooks/razorpay/society/:id
 *  - PLATFORM_COLLECT_PAYOUT: platform account collects, then settles to the society
 */
export async function resolveGateway(societyId: string): Promise<ResolvedGateway> {
  const policy = await FinancePolicy.findOne({ societyId }).lean();
  const mode: SettlementMode = policy?.settlement?.mode || 'OFFLINE_ONLY';

  if (mode === 'OWN_KEYS') {
    const ok = policy?.settlement?.ownKeys;
    if (!ok?.keyId || !ok.keySecretEnc || !ok.keySecretIv || !ok.keySecretTag) {
      throw new Error('This society has not configured its own payment gateway keys.');
    }
    const keySecret = decryptSecret(ok.keySecretEnc, ok.keySecretIv, ok.keySecretTag);
    const webhookSecret = (ok.webhookSecretEnc && ok.webhookSecretIv && ok.webhookSecretTag)
      ? decryptSecret(ok.webhookSecretEnc, ok.webhookSecretIv, ok.webhookSecretTag)
      : '';
    const client = RazorpayService.clientFromKeys(ok.keyId, keySecret);
    return {
      mode, online: true, webhookSecret,
      createLink: async (opts) => {
        const link = await RazorpayService.createPaymentLink({ ...opts, client });
        return { id: link.id, short_url: (link as any).short_url };
      },
    };
  }

  if (mode === 'PLATFORM_COLLECT_PAYOUT') {
    return {
      mode, online: true, webhookSecret: appConfig.razorpayWebhookSecret || '',
      createLink: async (opts) => {
        const link = await RazorpayService.createPaymentLink(opts);
        return { id: link.id, short_url: (link as any).short_url };
      },
    };
  }

  // OFFLINE_ONLY
  return {
    mode, online: false, webhookSecret: appConfig.razorpayWebhookSecret || '',
    createLink: async () => { throw new Error('Online payments are disabled (offline-only settlement).'); },
  };
}
