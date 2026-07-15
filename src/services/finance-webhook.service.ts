import { Receipt } from '../models/receipt.model';
import { RazorpayService } from './razorpay.service';
import { confirmGatewayReceipt } from './collections.service';
import { logger } from '../utils/logger.util';

/**
 * Verify + handle a Razorpay webhook for a society's maintenance collections.
 * Shared by the platform endpoint and the per-society (OWN_KEYS) endpoint.
 * Returns true if a finance Receipt was matched/handled.
 */
export async function handleFinanceWebhook(
  societyId: string,
  rawBody: Buffer | string,
  signature: string,
  webhookSecret: string,
): Promise<boolean> {
  if (!RazorpayService.verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    throw new Error('Invalid webhook signature');
  }
  const event = JSON.parse(rawBody.toString());
  if (event?.event !== 'payment_link.paid') return false;

  const linkId = event?.payload?.payment_link?.entity?.id;
  const paymentId = event?.payload?.payment?.entity?.id;
  const eventId = event?.id;
  if (!linkId) return false;

  const receipt = await Receipt.findOne({ societyId, razorpayPaymentLinkId: linkId });
  if (!receipt) return false;
  if (receipt.status === 'CLEARED') return true; // idempotent
  if (await Receipt.findOne({ razorpayWebhookEventId: eventId })) return true;

  await confirmGatewayReceipt(societyId, receipt._id.toString(), { razorpayPaymentId: paymentId, razorpayWebhookEventId: eventId }, { userId: 'SYSTEM', userName: 'Razorpay Webhook' });
  logger.info(`[finance-webhook] society ${societyId}: receipt ${receipt.receiptNumber} cleared via gateway`);
  return true;
}
