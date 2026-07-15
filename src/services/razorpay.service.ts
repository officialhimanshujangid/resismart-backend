import crypto from 'crypto';
import Razorpay from 'razorpay';
import { appConfig, isRazorpayConfigured } from '../config/appConfig';
import { logger } from '../utils/logger.util';

/**
 * Thin wrapper around the live Razorpay SDK.
 *
 * The client is lazily instantiated so the application can still boot when keys
 * are not configured; any attempt to actually transact will throw a clear error.
 */
export class RazorpayService {
  private static client: Razorpay | null = null;

  private static getClient(): Razorpay {
    if (!isRazorpayConfigured()) {
      throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }
    if (!this.client) {
      this.client = new Razorpay({
        key_id: appConfig.razorpayKeyId,
        key_secret: appConfig.razorpayKeySecret,
      });
    }
    return this.client;
  }

  /**
   * Creates a Razorpay order for a one-time payment.
   * @param amountInPaise Integer amount in the smallest currency unit (paise).
   * @param receiptId Our internal reference (invoice id) — must be <= 40 chars.
   */
  static async createOrder(amountInPaise: number, receiptId: string) {
    const order = await this.getClient().orders.create({
      amount: Math.round(amountInPaise),
      currency: 'INR',
      receipt: receiptId.slice(0, 40),
      payment_capture: true,
    });
    logger.info(`Razorpay order created: ${order.id} for receipt ${receiptId}`);
    return order;
  }

  /**
   * Creates a Razorpay Plan object for a recurring billing cycle.
   * Razorpay plans are immutable — a price/period change requires a new plan.
   */
  static async createPlan(opts: { period: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number; name: string; amountPaise: number; currency?: string }) {
    const plan = await this.getClient().plans.create({
      period: opts.period,
      interval: opts.interval,
      item: {
        name: opts.name,
        amount: Math.round(opts.amountPaise),
        currency: opts.currency || 'INR',
      },
    } as any);
    logger.info(`Razorpay plan created: ${plan.id} (${opts.name})`);
    return plan;
  }

  /**
   * Creates a Razorpay Subscription against a plan. The customer authorizes a
   * mandate at checkout and is then auto-charged each cycle until cancelled.
   */
  static async createSubscription(opts: { razorpayPlanId: string; totalCount: number; notes?: Record<string, string>; startAt?: number }) {
    const payload: any = {
      plan_id: opts.razorpayPlanId,
      total_count: opts.totalCount,
      customer_notify: 1,
      notes: opts.notes || {},
    };
    if (opts.startAt) payload.start_at = opts.startAt;
    
    const sub = await this.getClient().subscriptions.create(payload);
    logger.info(`Razorpay subscription created: ${sub.id}`);
    return sub;
  }

  /** Cancels a Razorpay subscription (immediately by default). */
  static async cancelSubscription(subscriptionId: string, cancelAtCycleEnd = false) {
    return this.getClient().subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
  }

  /**
   * Creates a one-time hosted Payment Link (for owner-initiated online collection).
   * Razorpay emails/SMSes the link and fires `payment_link.paid` when paid.
   */
  /** Build a Razorpay client from a society's OWN keys (for per-society settlement). */
  static clientFromKeys(keyId: string, keySecret: string): Razorpay {
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  static async createPaymentLink(opts: {
    amountPaise: number;
    description: string;
    customer: { name?: string; email?: string; contact?: string };
    notes?: Record<string, string>;
    callbackUrl?: string;
    client?: Razorpay; // when set, use this (per-society) client instead of the platform one
  }) {
    const rzp = opts.client || this.getClient();
    const link = await rzp.paymentLink.create({
      amount: Math.round(opts.amountPaise),
      currency: 'INR',
      description: opts.description.slice(0, 2048),
      customer: {
        name: opts.customer.name,
        email: opts.customer.email,
        contact: opts.customer.contact,
      },
      notify: { email: Boolean(opts.customer.email), sms: Boolean(opts.customer.contact) },
      reminder_enable: true,
      notes: opts.notes || {},
      ...(opts.callbackUrl ? { callback_url: opts.callbackUrl, callback_method: 'get' } : {}),
    } as any);
    logger.info(`Razorpay payment link created: ${link.id}`);
    return link;
  }

  /** Fetches the current state of a payment link (used to poll/confirm payment). */
  static async fetchPaymentLink(id: string) {
    return this.getClient().paymentLink.fetch(id);
  }

  /**
   * Verifies the signature returned by Razorpay Checkout after a one-time ORDER
   * payment. HMAC is over `order_id|payment_id`.
   */
  static verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!appConfig.razorpayKeySecret) return false;
    const expected = crypto
      .createHmac('sha256', appConfig.razorpayKeySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    return this.timingSafeEqual(expected, signature);
  }

  /**
   * Verifies the signature returned after a SUBSCRIPTION authorization.
   * Note the order differs from orders: HMAC is over `payment_id|subscription_id`.
   */
  static verifySubscriptionSignature(subscriptionId: string, paymentId: string, signature: string): boolean {
    if (!appConfig.razorpayKeySecret) return false;
    const expected = crypto
      .createHmac('sha256', appConfig.razorpayKeySecret)
      .update(`${paymentId}|${subscriptionId}`)
      .digest('hex');
    return this.timingSafeEqual(expected, signature);
  }

  /**
   * Creates a contact in Razorpay for a vendor (society).
   */
  static async createContact(societyId: string, name: string, email?: string): Promise<any> {
    // @ts-ignore
    const contact = await this.getClient().api.post({
      url: '/contacts',
      data: {
        name,
        email,
        type: 'vendor',
        reference_id: societyId,
      }
    });
    logger.info(`Razorpay contact created: ${(contact as any).id} for society ${societyId}`);
    return contact;
  }

  /**
   * Creates a fund account linked to a Razorpay contact (bank account).
   */
  static async createFundAccount(contactId: string, accountName: string, accountNumber: string, ifsc: string): Promise<any> {
    // @ts-ignore
    const fundAccount = await this.getClient().api.post({
      url: '/fund_accounts',
      data: {
        contact_id: contactId,
        account_type: 'bank_account',
        bank_account: {
          name: accountName,
          account_number: accountNumber,
          ifsc,
        }
      }
    });
    logger.info(`Razorpay fund account created: ${(fundAccount as any).id} for contact ${contactId}`);
    return fundAccount;
  }

  /**
   * Validates a fund account via penny drop.
   */
  static async validateFundAccount(fundAccountId: string, accountNumber: string): Promise<any> {
    // @ts-ignore
    const validation = await this.getClient().api.post({
      url: '/fund_accounts/validations',
      data: {
        account_number: accountNumber,
        fund_account: {
          id: fundAccountId
        },
        amount: 100, // ₹1
        currency: 'INR',
        notes: {
          description: 'Society verification',
        }
      }
    });
    logger.info(`Razorpay fund account validation initiated: ${(validation as any).id} for fund account ${fundAccountId}`);
    return validation;
  }

  /**
   * Fetches the status of a validation request.
   */
  static async fetchValidation(validationId: string): Promise<any> {
    // The razorpay node SDK might not have a direct fetch method for validation
    // If not, we can use the generic api wrapper or `api.get` but Razorpay SDK v2.9+ should support it or we can do it via API.
    // Assuming standard SDK doesn't have it directly exposed as `fundAccount.fetchValidation`
    // We'll use the raw request method:
    // @ts-ignore
    return this.getClient().api.get({
      url: `/fund_accounts/validations/${validationId}`,
    });
  }

  /**
   * Verifies an incoming webhook payload using the configured webhook secret.
   * @param rawBody The exact raw request body bytes (NOT the parsed JSON).
   */
  static verifyWebhookSignature(rawBody: Buffer | string, signature: string, secret?: string): boolean {
    const webhookSecret = secret || appConfig.razorpayWebhookSecret;
    if (!webhookSecret || !signature) return false;
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    return this.timingSafeEqual(expected, signature);
  }

  private static timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
}

export default RazorpayService;
