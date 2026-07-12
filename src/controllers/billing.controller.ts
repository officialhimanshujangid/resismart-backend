import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Plan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { Invoice, IInvoice } from '../models/invoice.model';
import { Society } from '../models/society.model';
import { Shop } from '../models/shop.model';
import { User } from '../models/user.model';
import { RazorpayService } from '../services/razorpay.service';
import { ensureRazorpayPlans } from '../services/razorpay-plan.service';
import { InvoiceService } from '../services/invoice.service';
import s3Service from '../services/s3.service';
import EmailService from '../services/email.service';
import { AuditService } from '../services/audit.service';
import { resolveTenantEmail } from '../utils/tenant-email.util';
import { getGoverningSubscription, getEffectiveLimits, capsToObject } from '../services/subscription-lifecycle.service';
import { runExpireOverdue, runExpiryReminders } from '../services/cron.service';
import { activateBoostByOrder } from '../services/listing-boost.service';
import { TenantType } from '../constants/roles';
import { appConfig, isRazorpayConfigured } from '../config/appConfig';
import { logger } from '../utils/logger.util';
import { checkoutSchema, verifyPaymentSchema, assignCashPlanSchema, upgradePreviewSchema, generateRenewalLinkSchema } from '../validators/billing.validator';

const auditBilling = (req: Request, tenantId: string, action: string, resourceId: string, values: any) => {
  AuditService.log({
    userId: req.user?.userId || 'system',
    userName: req.user?.userName || 'system',
    tenantId,
    tenantType: values.tenantType || TenantType.SOCIETY,
    action,
    resource: 'Subscription',
    resourceId,
    ipAddress: req.ip || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown',
    newValues: values,
  });
};

// How many cycles a recurring subscription is authorized for (~10 years horizon).
const TOTAL_COUNT: Record<string, number> = { monthly: 120, quarterly: 40, halfYearly: 20, yearly: 10 };

export class BillingController {
  /**
   * SOCIETY_ADMIN starts a recurring Razorpay Subscription for their tenant.
   * Creates a PENDING invoice and a Razorpay Subscription against the plan's
   * per-cycle Razorpay plan id.
   */
  static async checkoutRazorpay(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = checkoutSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });

      const { planId, tenure, intent } = parsed.data;
      const societyId = req.user?.activeTenantId;
      const tenantType = req.user?.activeTenantType || 'SOCIETY';
      if (!societyId) return res.status(403).json({ success: false, message: 'Tenant context missing' });
      if (!isRazorpayConfigured()) {
        return res.status(503).json({ success: false, message: 'Online payments are not available right now. Please contact support.' });
      }

      const plan = await Plan.findOne({ _id: planId, isActive: true, isDeleted: false });
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

      let cycle = plan.billingCycles.find((c) => c.tenure === tenure && c.isEnabled);
      if (!cycle) return res.status(400).json({ success: false, message: 'This billing cycle is not available for this plan' });

      // Self-heal: legacy plans created before Razorpay sync may lack a plan id.
      if (!cycle.razorpayPlanId) {
        await ensureRazorpayPlans(plan);
        cycle = plan.billingCycles.find((c) => c.tenure === tenure && c.isEnabled);
      }
      if (!cycle?.razorpayPlanId) {
        return res.status(400).json({ success: false, message: 'This plan is not yet set up for online subscriptions. Please try again shortly or contact support.' });
      }

      const pricing = plan.getPricingForTenure(tenure);
      if (!pricing) return res.status(400).json({ success: false, message: 'Invalid tenure for this plan' });

      const proration = await BillingController.proratePlanChange(new mongoose.Types.ObjectId(societyId), tenantType, plan, tenure);
      
      let amountInPaise = proration.amountPaise;
      let isOrder = intent === 'manual_renewal' || intent === 'upgrade';
      let startAt: number | undefined;

      if (intent === 'setup_autopay' && proration.existingPaid) {
        amountInPaise = 0;
        startAt = Math.floor(new Date(proration.existingPaid.endDate).getTime() / 1000);
        isOrder = false;
      }

      const invoice = await Invoice.create({
        tenantId: new mongoose.Types.ObjectId(societyId),
        tenantType: tenantType,
        planId: plan._id,
        tenure: tenure,
        invoiceType: 'ONLINE_RAZORPAY',
        amount: amountInPaise,
        status: 'PENDING',
      });

      let responsePayload: any = {
        success: true,
        keyId: appConfig.razorpayKeyId,
        invoiceId: invoice._id,
        planName: plan.name,
        amount: amountInPaise,
        currency: plan.currency || 'INR',
      };

      if (isOrder && amountInPaise > 0) {
        const order = await RazorpayService.createOrder(amountInPaise, invoice._id.toString());
        invoice.razorpayPaymentLinkId = order.id; // re-using this field for order_id
        await invoice.save();
        responsePayload.orderId = order.id;
      } else {
        const rzpSub = await RazorpayService.createSubscription({
          razorpayPlanId: cycle.razorpayPlanId,
          totalCount: TOTAL_COUNT[tenure] || 12,
          startAt,
          notes: { invoiceId: invoice._id.toString(), societyId: String(societyId) },
        });
        invoice.razorpaySubscriptionId = rzpSub.id;
        await invoice.save();
        responsePayload.subscriptionId = rzpSub.id;
      }

      return res.status(200).json(responsePayload);
    } catch (error: any) {
      logger.error(`checkoutRazorpay failed: ${error.message}`);
      next(error);
    }
  }

  /**
   * SOCIETY_ADMIN confirms the subscription authorization from the client.
   * Verifies the signature, then activates the local subscription idempotently.
   */
  static async verifyPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = verifyPaymentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });

      const { invoiceId, razorpay_subscription_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;
      const societyId = req.user?.activeTenantId;

      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
      if (societyId && invoice.tenantId.toString() !== societyId) {
        return res.status(403).json({ success: false, message: 'This invoice does not belong to your society' });
      }
      
      let valid = false;
      if (razorpay_order_id) {
        if (invoice.razorpayPaymentLinkId !== razorpay_order_id) {
          return res.status(400).json({ success: false, message: 'Order mismatch' });
        }
        valid = RazorpayService.verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      } else if (razorpay_subscription_id) {
        if (invoice.razorpaySubscriptionId !== razorpay_subscription_id) {
          return res.status(400).json({ success: false, message: 'Subscription mismatch' });
        }
        valid = RazorpayService.verifySubscriptionSignature(razorpay_subscription_id, razorpay_payment_id, razorpay_signature);
      }
      
      if (!valid) return res.status(400).json({ success: false, message: 'Payment signature verification failed' });

      // activateFromInvoice works for both orders and subscriptions since it applies the prorated change.
      const subscription = await BillingController.activateFromInvoice(invoice, razorpay_payment_id, req.user?.userName || 'Society Admin', razorpay_subscription_id);

      if (subscription) {
        auditBilling(req, invoice.tenantId.toString(), 'SUBSCRIPTION_ACTIVATE', subscription._id.toString(), {
          via: 'razorpay', paymentId: razorpay_payment_id, subscriptionId: razorpay_subscription_id, orderId: razorpay_order_id, amount: invoice.amount,
        });
      }

      return res.status(200).json({ success: true, message: 'Subscription activated successfully.', subscription });
    } catch (error: any) {
      logger.error(`verifyPayment failed: ${error.message}`);
      next(error);
    }
  }

  /**
   * Razorpay webhook receiver (raw body provided by app.ts). Handles recurring
   * subscription lifecycle events.
   */
  static async razorpayWebhook(req: Request, res: Response) {
    try {
      const signature = req.headers['x-razorpay-signature'] as string;
      const rawBody: Buffer = (req as any).rawBody || req.body;

      if (!RazorpayService.verifyWebhookSignature(rawBody, signature)) {
        logger.warn('Rejected Razorpay webhook with invalid signature');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      const event = JSON.parse(rawBody.toString());
      const type = event?.event;
      const rzpSubId = event?.payload?.subscription?.entity?.id;
      const paymentId = event?.payload?.payment?.entity?.id;

      if (type === 'payment_link.paid') {
        const linkId = event?.payload?.payment_link?.entity?.id;
        if (linkId) {
          const invoice = await Invoice.findOne({ razorpayPaymentLinkId: linkId });
          if (invoice && invoice.status !== 'PAID') await BillingController.processPaidLinkInvoice(invoice, paymentId);
        }
      } else if (type === 'subscription.charged' && rzpSubId) {
        await BillingController.handleSubscriptionCharged(rzpSubId, paymentId);
      } else if (type === 'order.paid') {
        // Ad-boost orders (Phase 4). No-op for non-boost orders (returns null).
        const orderId = event?.payload?.order?.entity?.id;
        if (orderId) await activateBoostByOrder(orderId, paymentId);
      } else if ((type === 'subscription.cancelled' || type === 'subscription.completed') && rzpSubId) {
        const localSub = await Subscription.findOne({ razorpaySubscriptionId: rzpSubId });
        if (localSub && !['cancelled', 'expired'].includes(localSub.status)) {
          localSub.status = type === 'subscription.completed' ? 'expired' : 'cancelled';
          localSub.history.push({ action: type === 'subscription.completed' ? 'expired' : 'cancelled', note: `Razorpay event: ${type}`, performedBy: 'razorpay-webhook', date: new Date() } as any);
          await localSub.save();
        }
      }

      return res.status(200).json({ received: true });
    } catch (error: any) {
      logger.error(`razorpayWebhook failed: ${error.message}`);
      return res.status(500).json({ success: false });
    }
  }

  /**
   * SOCIETY_ADMIN cancels their active online subscription. Cancels at Razorpay
   * and marks the local subscription cancelled.
   */
  static async cancelSubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) return res.status(403).json({ success: false, message: 'No tenant context' });

      const sub = await Subscription.findOne({
        tenantId: new mongoose.Types.ObjectId(societyId),
        tenantType: req.user?.activeTenantType || 'SOCIETY',
        status: { $in: ['active', 'trialing', 'past_due', 'scheduled'] },
        razorpaySubscriptionId: { $exists: true, $ne: null }
      }).sort({ createdAt: -1 });

      if (!sub) return res.status(404).json({ success: false, message: 'No active auto-pay found to cancel' });

      if (sub.razorpaySubscriptionId && isRazorpayConfigured()) {
        try {
          await RazorpayService.cancelSubscription(sub.razorpaySubscriptionId, false);
        } catch (e: any) {
          logger.error(`Razorpay cancel failed for ${sub.razorpaySubscriptionId}: ${e.message}`);
        }
      }

      // Do not change status to 'cancelled' so the user can use the remaining paid days.
      // Just remove the razorpaySubscriptionId to stop auto-renewal.
      sub.razorpaySubscriptionId = undefined;
      
      // If the subscription was purely a scheduled mandate (no charges made), we can cancel it fully?
      // Wait, if it's scheduled and hasn't started, they didn't pay for it yet. But let's leave it as scheduled but without autopay, so it just becomes a pending scheduled plan.
      sub.history.push({ action: 'cancelled_autopay', note: 'Auto-renewal cancelled by society admin', performedBy: req.user?.userName || 'Society Admin', date: new Date() } as any);
      await sub.save();

      auditBilling(req, String(societyId), 'SUBSCRIPTION_CANCEL_AUTOPAY', sub._id.toString(), { cancelledBy: req.user?.userName });

      return res.status(200).json({ success: true, message: 'Subscription cancelled.', subscription: sub });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * OWNER assigns/upgrades a plan, collecting payment by CASH (recorded immediately)
   * or ONLINE (a Razorpay payment link is emailed; the plan auto-activates on payment).
   */
  static async assignCashPlan(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = assignCashPlanSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });

      const { societyId, shopId, tenantId, tenantType, planId, tenure, paymentMethod, note, collectedById, collectedByName } = parsed.data;
      const performedBy = req.user?.userName || 'Super Admin';
      const actualTenantId = tenantId || shopId || societyId;
      const actualTenantType = tenantType || (shopId ? 'SHOP' : 'SOCIETY');

      const [plan, tenant] = await Promise.all([
        Plan.findOne({ _id: planId, isDeleted: false }),
        actualTenantType === 'SHOP' ? Shop.findById(actualTenantId) : Society.findById(actualTenantId),
      ]);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
      if (!plan.getPricingForTenure(tenure)) return res.status(400).json({ success: false, message: 'Invalid tenure' });

      // Compute prorated amount/credit/mode (without applying yet).
      const proration = await BillingController.proratePlanChange(tenant._id as mongoose.Types.ObjectId, actualTenantType, plan, tenure);

      let recipientEmail = actualTenantType === 'SHOP' ? (tenant as any).adminEmail : (tenant as any).contactEmail;
      if (!recipientEmail && tenant.adminUserId) {
        const adminUser = await User.findById(tenant.adminUserId).select('email').lean();
        recipientEmail = adminUser?.email;
      }

      // ── ONLINE: create a Razorpay payment link, email it, wait for webhook/poll ──
      if (paymentMethod === 'online') {
        if (!isRazorpayConfigured()) return res.status(503).json({ success: false, message: 'Online payments are not configured.' });
        if (!recipientEmail) return res.status(400).json({ success: false, message: 'This society has no contact email to send the payment link to.' });

        const invoice = await Invoice.create({
          tenantId: tenant._id,
          tenantType: actualTenantType,
          planId: plan._id,
          tenure,
          invoiceType: 'ONLINE_RAZORPAY',
          amount: proration.amountPaise,
          creditApplied: proration.creditPaise,
          status: 'PENDING',
          recordedById: req.user?.userId,
          recordedByName: performedBy,
          customInvoiceNumber: `INV-${Date.now()}`,
        });

        const link = await RazorpayService.createPaymentLink({
          amountPaise: proration.amountPaise,
          description: `${plan.name} (${tenure}) — ${tenant.name}`,
          customer: { name: (tenant as any).contactName || tenant.name, email: recipientEmail, contact: (tenant as any).contactPhone || (tenant as any).contactNumber },
          notes: { invoiceId: invoice._id.toString(), societyId: tenant._id.toString(), tenantType: actualTenantType },
        });
        invoice.razorpayPaymentLinkId = link.id;
        invoice.razorpayPaymentLinkUrl = (link as any).short_url;
        await invoice.save();

        EmailService.sendPaymentLinkEmail(recipientEmail, tenant.name, plan.name, proration.amountPaise, (link as any).short_url);
        auditBilling(req, tenant._id.toString(), 'SUBSCRIPTION_PAYMENT_LINK', invoice._id.toString(), {
          tenantType: actualTenantType, mode: proration.mode, plan: plan.name, tenure, amount: proration.amountPaise, sentTo: recipientEmail, link: (link as any).short_url,
        });

        return res.status(200).json({
          success: true, method: 'online', mode: proration.mode,
          message: `Payment link sent to ${recipientEmail}. The plan will activate automatically once paid.`,
          paymentLinkUrl: (link as any).short_url, invoiceId: invoice._id, amount: proration.amountPaise,
        });
      }

      // ── CASH: apply immediately and record a PAID invoice ──
      let resolvedCollectedName = collectedByName;
      if (collectedById && !resolvedCollectedName) {
        const u = await User.findById(collectedById).select('name').lean();
        resolvedCollectedName = u?.name;
      }

      const { subscription, mode, creditPaise, amountPaise } = await BillingController.applyPlanChange(tenant, actualTenantType, plan, tenure, performedBy, note);

      const invoice = await Invoice.create({
        tenantId: tenant._id,
        tenantType: actualTenantType,
        subscriptionId: subscription._id,
        planId: plan._id,
        tenure,
        invoiceType: 'OFFLINE_CASH',
        amount: amountPaise,
        creditApplied: creditPaise,
        status: 'PAID',
        paidAt: new Date(),
        customInvoiceNumber: `INV-${Date.now()}`,
        collectedById,
        collectedByName: resolvedCollectedName,
        recordedById: req.user?.userId,
        recordedByName: performedBy,
      });

      let pdfUrl: string | null = null;
      try {
        pdfUrl = await InvoiceService.generateCustomInvoice(invoice, subscription, plan, {
          societyName: tenant.name, recipientEmail, tenure, currency: plan.currency,
          collectedByName: resolvedCollectedName, recordedByName: performedBy, creditApplied: creditPaise,
        });
      } catch (pdfErr: any) {
        logger.error(`Invoice PDF generation failed for ${invoice._id}: ${pdfErr.message}`);
      }

      if (recipientEmail) EmailService.sendPaymentReceiptEmail(recipientEmail, tenant.name, plan.name, amountPaise, tenure);

      auditBilling(req, tenant._id.toString(), 'SUBSCRIPTION_CASH_ASSIGN', subscription._id.toString(), {
        tenantType: actualTenantType, mode, plan: plan.name, tenure, amountCollected: amountPaise, creditApplied: creditPaise,
        invoiceNumber: invoice.customInvoiceNumber, collectedBy: resolvedCollectedName, recordedBy: performedBy, endDate: subscription.endDate,
      });

      const messageByMode = mode === 'upgraded' ? 'Plan upgraded (cash) and invoice generated.' : mode === 'scheduled' ? 'Upcoming plan scheduled (cash) and invoice generated.' : 'Cash plan assigned and invoice generated.';
      return res.status(200).json({ success: true, method: 'cash', message: messageByMode, mode, creditApplied: creditPaise, amountCollected: amountPaise, subscription, invoice, pdfUrl });
    } catch (error: any) {
      logger.error(`assignCashPlan failed: ${error.message}`);
      next(error);
    }
  }

  /** Owner/society-admin polls an online invoice; self-heals via Razorpay if webhook hasn't arrived. */
  static async getInvoiceStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const invoice = await Invoice.findById(req.params.id);
      if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

      const isOwner = req.user?.activeRole === 'SYSTEM_OWNER' || req.user?.activeRole === 'SYSTEM_EMPLOYEE';
      if (!isOwner && invoice.tenantId.toString() !== req.user?.activeTenantId) {
        return res.status(403).json({ success: false, message: 'Not allowed' });
      }

      // Fallback when the webhook hasn't fired yet (e.g. no public URL in dev).
      if (invoice.status === 'PENDING' && invoice.razorpayPaymentLinkId && isRazorpayConfigured()) {
        try {
          const link: any = await RazorpayService.fetchPaymentLink(invoice.razorpayPaymentLinkId);
          if (link?.status === 'paid') {
            const payId = link?.payments?.[0]?.payment_id;
            await BillingController.processPaidLinkInvoice(invoice, payId);
          }
        } catch (e: any) {
          logger.error(`fetchPaymentLink failed for ${invoice.razorpayPaymentLinkId}: ${e.message}`);
        }
      }

      const fresh = await Invoice.findById(req.params.id).select('status razorpayPaymentLinkUrl amount').lean();
      return res.status(200).json({ success: true, status: fresh?.status, paymentLinkUrl: fresh?.razorpayPaymentLinkUrl });
    } catch (error) {
      next(error);
    }
  }

  /**
   * OWNER: preview the prorated cost of changing a society to a new plan/tenure
   * BEFORE committing. Returns credit for unused time + amount due + new end date.
   */
  static async upgradePreview(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = upgradePreviewSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
      const { societyId, shopId, tenantId, tenantType, planId, tenure, intent } = parsed.data;
      const actualTenantId = tenantId || shopId || societyId || req.user?.activeTenantId;
      const actualTenantType = tenantType || (shopId ? 'SHOP' : (req.user?.activeTenantType || 'SOCIETY'));

      const isOwner = req.user?.activeRole === 'SYSTEM_OWNER' || req.user?.activeRole === 'SYSTEM_EMPLOYEE';
      if (!isOwner && actualTenantId !== req.user?.activeTenantId) {
        return res.status(403).json({ success: false, message: 'You can only preview upgrades for your own society.' });
      }

      const newPlan = await Plan.findOne({ _id: planId, isDeleted: false });
      if (!newPlan) return res.status(404).json({ success: false, message: 'Plan not found' });
      if (!newPlan.getPricingForTenure(tenure)) return res.status(400).json({ success: false, message: 'Invalid tenure' });

      const p = await BillingController.proratePlanChange(actualTenantId as string, actualTenantType, newPlan, tenure);
      
      if (intent === 'setup_autopay' && p.existingPaid) {
        p.amountPaise = 0;
      }
      
      let currentPlanName: string | null = null;
      let remainingDays = 0;
      if (p.existingPaid) {
        const currentPlan = await Plan.findById(p.existingPaid.planId);
        currentPlanName = currentPlan?.name || null;
        remainingDays = Math.round(Math.max(0, new Date(p.existingPaid.endDate).getTime() - Date.now()) / 86400000);
      }

      return res.status(200).json({
        success: true,
        preview: {
          mode: p.mode, // 'new' | 'scheduled' | 'upgraded'
          currentPlanName,
          newPlanName: newPlan.name,
          tenure,
          newPricePaise: p.newPricePaise,
          creditPaise: p.creditPaise,
          amountDuePaise: p.amountPaise,
          remainingDays,
          bonusDays: p.bonusDays,
          startDate: p.startDate,
          newEndDate: p.endDate,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** Paginated invoice history (society admins: own tenant; owners: all / by ?societyId=). */
  static async getInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, pageSize, isPagination, status, societyId, shopId, tenantId, tenantType } = req.query;
      const filter: Record<string, any> = {};

      const isOwner = req.user?.activeRole === 'SYSTEM_OWNER' || req.user?.activeRole === 'SYSTEM_EMPLOYEE';
      if (isOwner) {
        const queryTenantId = societyId || shopId || tenantId;
        if (queryTenantId) filter.tenantId = new mongoose.Types.ObjectId(String(queryTenantId));
        if (tenantType) filter.tenantType = String(tenantType);
      } else {
        if (!req.user?.activeTenantId) return res.status(403).json({ success: false, message: 'No tenant context' });
        filter.tenantId = new mongoose.Types.ObjectId(req.user.activeTenantId);
      }
      if (status && ['PAID', 'PENDING', 'FAILED', 'REFUNDED'].includes(String(status))) filter.status = status;

      const attachSocietyNames = async (rows: any[]) => {
        if (!isOwner) return rows;
        const ids = [...new Set(rows.map((r) => String(r.tenantId)))];
        const [societies, shops] = await Promise.all([
          Society.find({ _id: { $in: ids } }).select('name').lean(),
          Shop.find({ _id: { $in: ids } }).select('name').lean()
        ]);
        const nameById = new Map([...societies, ...shops].map((s) => [String(s._id), s.name]));
        return rows.map((r) => ({ ...r, societyName: nameById.get(String(r.tenantId)) || '—' }));
      };

      if (isPagination === 'true') {
        const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
        const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
        const skip = (currentPage - 1) * limit;

        const [rows, total] = await Promise.all([
          Invoice.find(filter).populate('planId', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
          Invoice.countDocuments(filter),
        ]);

        return res.status(200).json({
          success: true,
          invoices: await attachSocietyNames(rows),
          pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
        });
      }

      const invoices = await Invoice.find(filter).populate('planId', 'name').sort({ createdAt: -1 }).lean();
      return res.status(200).json({ success: true, invoices: await attachSocietyNames(invoices) });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Returns a short-lived presigned download URL for an invoice PDF. Invoices are
   * private on S3; access is authorized (own tenant for society admins, any for owners).
   */
  static async getInvoiceDownload(req: Request, res: Response, next: NextFunction) {
    try {
      const invoice = await Invoice.findById(req.params.id).lean();
      if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

      const isOwner = req.user?.activeRole === 'SYSTEM_OWNER' || req.user?.activeRole === 'SYSTEM_EMPLOYEE';
      if (!isOwner && invoice.tenantId.toString() !== req.user?.activeTenantId) {
        return res.status(403).json({ success: false, message: 'You cannot access this invoice' });
      }

      // Razorpay-hosted invoices are already accessible.
      if (invoice.razorpayInvoiceUrl) {
        return res.status(200).json({ success: true, url: invoice.razorpayInvoiceUrl });
      }

      if (!invoice.customPdfUrl) {
        return res.status(404).json({ success: false, message: 'No PDF available for this invoice' });
      }

      const key = s3Service.keyFromUrl(invoice.customPdfUrl);
      if (!key) return res.status(500).json({ success: false, message: 'Could not resolve invoice file' });

      const url = await s3Service.getSignedDownloadUrl(key, {
        expiresIn: 300,
        downloadName: `${invoice.customInvoiceNumber || 'invoice'}.pdf`,
      });
      return res.status(200).json({ success: true, url });
    } catch (error) {
      next(error);
    }
  }

  /** Current subscription + live limits for the logged-in society admin's tenant. */
  static async getMySubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.activeTenantId;
      const tenantType = req.user?.activeTenantType || 'SOCIETY';
      if (!tenantId) return res.status(403).json({ success: false, message: 'No tenant context' });

      const subscription = await getGoverningSubscription(tenantId, tenantType);
      const eff = await getEffectiveLimits(tenantId, tenantType);

      // Upcoming (scheduled / future) terms, soonest first.
      const upcoming = await Subscription.find({
        tenantId: new mongoose.Types.ObjectId(tenantId),
        tenantType: tenantType,
        status: 'scheduled',
      }).sort({ startDate: 1 }).populate('planId', 'name').lean();

      let nextAmountPaise = 0;
      if (subscription && subscription.planId && !subscription.isFreeTier) {
        const planDoc = subscription.planId as any;
        if (planDoc.getPricingForTenure) {
          const pricing = planDoc.getPricingForTenure(subscription.tenure);
          if (pricing) nextAmountPaise = pricing.totalPrice * 100;
        }
      }

      return res.status(200).json({
        success: true,
        subscription,
        upcoming,
        capabilities: eff.limits,
        planStatus: { planName: eff.planName, status: eff.status, isFreeTier: eff.isFreeTier, endDate: eff.endDate, graceEndsAt: eff.graceEndsAt },
        nextAmountPaise,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /** Owner: paginated list of ALL subscriptions across tenants. */
  static async getSubscriptions(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, pageSize, isPagination, status, societyId, shopId, tenantType } = req.query;
      const filter: Record<string, any> = {};
      if (tenantType) filter.tenantType = tenantType;
      if (status && ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'pending_payment'].includes(String(status))) {
        filter.status = status;
      }
      if (societyId) filter.tenantId = new mongoose.Types.ObjectId(String(societyId));
      if (shopId) filter.tenantId = new mongoose.Types.ObjectId(String(shopId));

      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = isPagination === 'true' ? Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10))) : 1000;
      const skip = (currentPage - 1) * limit;

      const [subs, total] = await Promise.all([
        Subscription.find(filter).populate('planId', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Subscription.countDocuments(filter),
      ]);

      const tenantIds = [...new Set(subs.map((s) => String(s.tenantId)))];
      const [societies, shops] = await Promise.all([
        Society.find({ _id: { $in: tenantIds } }).select('name').lean(),
        Shop.find({ _id: { $in: tenantIds } }).select('name').lean()
      ]);
      const nameById = new Map([...societies, ...shops].map((s) => [String(s._id), s.name]));
      const data = subs.map((s) => ({ ...s, societyName: nameById.get(String(s.tenantId)) || '—' }));

      return res.status(200).json({
        success: true,
        subscriptions: data,
        pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  /** OWNER: one-call subscription KPI summary. */
  static async getSubscriptionStats(_req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await Subscription.aggregate([
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]);
      const m: Record<string, number> = {};
      let total = 0;
      rows.forEach((r) => { m[r._id] = r.n; total += r.n; });
      return res.status(200).json({
        success: true,
        stats: { total, active: m.active || 0, trialing: m.trialing || 0, past_due: m.past_due || 0, expired: m.expired || 0, cancelled: m.cancelled || 0, scheduled: m.scheduled || 0 },
      });
    } catch (error) {
      next(error);
    }
  }

  /** One-call invoice KPI summary (society admins: own tenant; owners: all / by ?societyId=). */
  static async getInvoiceStats(req: Request, res: Response, next: NextFunction) {
    try {
      const match: Record<string, any> = {};
      const isOwner = req.user?.activeRole === 'SYSTEM_OWNER' || req.user?.activeRole === 'SYSTEM_EMPLOYEE';
      if (isOwner) {
        if (req.query.societyId) match.tenantId = new mongoose.Types.ObjectId(String(req.query.societyId));
      } else {
        if (!req.user?.activeTenantId) return res.status(403).json({ success: false, message: 'No tenant context' });
        match.tenantId = new mongoose.Types.ObjectId(req.user.activeTenantId);
      }
      const rows = await Invoice.aggregate([
        { $match: match },
        { $group: { _id: '$status', n: { $sum: 1 }, amt: { $sum: '$amount' } } },
      ]);
      let total = 0, paid = 0, pending = 0, failed = 0, refunded = 0, revenuePaise = 0;
      rows.forEach((r) => {
        total += r.n;
        if (r._id === 'PAID') { paid = r.n; revenuePaise = r.amt; }
        else if (r._id === 'PENDING') pending = r.n;
        else if (r._id === 'FAILED') failed = r.n;
        else if (r._id === 'REFUNDED') refunded = r.n;
      });
      return res.status(200).json({ success: true, stats: { total, paid, pending, failed, refunded, revenuePaise } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * OWNER: run subscription maintenance on demand (auto-expire overdue + send
   * expiry reminders) — the same jobs the daily cron runs at 09:00.
   */
  static async runMaintenance(_req: Request, res: Response, next: NextFunction) {
    try {
      await runExpireOverdue();
      await runExpiryReminders();
      return res.status(200).json({ success: true, message: 'Subscription maintenance executed (statuses synced, reminders sent).' });
    } catch (error) {
      next(error);
    }
  }

  // ---------- Helpers ----------

  /**
   * Computes mode/credit/amount/endDate for changing a society to a plan/tenure,
   * WITHOUT persisting. Shared by preview, cash apply and online link amount.
   */
  private static async proratePlanChange(tenantId: mongoose.Types.ObjectId | string, tenantType: string, newPlan: any, tenure: string) {
    const newPricing = newPlan.getPricingForTenure(tenure);
    const newPricePaise = (newPricing?.totalPrice || 0) * 100;
    const months = newPricing?.durationMonths || 1;
    const now = new Date();

    // Only a PAID, currently-running or upcoming plan affects mode/proration (free tier is just a baseline).
    const existingPaid = await Subscription.findOne({
      tenantId: new mongoose.Types.ObjectId(String(tenantId)),
      tenantType: tenantType,
      isFreeTier: { $ne: true },
      status: { $in: ['active', 'past_due', 'scheduled'] },
    }).sort({ endDate: -1 });

    let mode: 'new' | 'scheduled' | 'upgraded' = 'new';
    let creditPaise = 0;
    let amountPaise = newPricePaise;
    let bonusDays = 0;
    let startDate = new Date(now);
    let endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + months);

    if (existingPaid && new Date(existingPaid.endDate) > now) {
      const samePlan = existingPaid.planId.toString() === newPlan._id.toString();
      if (samePlan) {
        // Renewal of the same plan → queue an UPCOMING term starting when the current ends.
        mode = 'scheduled';
        startDate = new Date(existingPaid.endDate);
        endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + months);
      } else {
        // Different plan → upgrade NOW with prorated credit for the unused current term.
        mode = 'upgraded';
        const currentPlan = await Plan.findById(existingPaid.planId);
        const currentPricePaise = (currentPlan?.getPricingForTenure(existingPaid.tenure)?.totalPrice || 0) * 100;
        const totalMs = Math.max(1, new Date(existingPaid.endDate).getTime() - new Date(existingPaid.startDate).getTime());
        const remainMs = Math.max(0, new Date(existingPaid.endDate).getTime() - now.getTime());
        creditPaise = Math.floor((remainMs / totalMs) * currentPricePaise);
        amountPaise = Math.max(0, newPricePaise - creditPaise);
        if (creditPaise > newPricePaise && newPricePaise > 0) {
          const daily = newPricePaise / (months * 30);
          bonusDays = daily > 0 ? Math.floor((creditPaise - newPricePaise) / daily) : 0;
          endDate.setDate(endDate.getDate() + bonusDays);
        }
      }
    }

    return { existingPaid, mode, creditPaise, amountPaise, startDate, endDate, newPricePaise, bonusDays };
  }

  /** Applies a plan change to a society (new / upgrade now / schedule upcoming), syncing Razorpay. Persists. */
  private static async applyPlanChange(tenant: any, tenantType: string, plan: any, tenure: string, performedBy: string, note?: string) {
    const now = new Date();
    const { mode, creditPaise, amountPaise, startDate, endDate } = await BillingController.proratePlanChange(tenant._id, tenantType, plan, tenure);

    // Find any currently running plans (active, past_due, trialing)
    const current = await Subscription.find({
      tenantId: tenant._id, tenantType: tenantType,
      status: { $in: ['active', 'past_due', 'trialing'] },
    });

    // If there is ANY active Razorpay subscription, we MUST cancel it at the gateway 
    // to prevent double billing, regardless of whether this is a scheduled renewal or upgrade.
    for (const c of current) {
      if (c.razorpaySubscriptionId && isRazorpayConfigured()) {
        try { 
          await RazorpayService.cancelSubscription(c.razorpaySubscriptionId, false); 
          c.history.push({
            action: 'cancelled',
            note: 'Razorpay auto-renewal cancelled automatically due to manual offline plan assignment.',
            performedBy: 'System', date: now
          } as any);
          await c.save();
        }
        catch (e: any) { logger.error(`Razorpay cancel during plan change failed: ${e.message}`); }
      }
    }

    // Same-plan renewal → queue a SCHEDULED upcoming term; leave the current plan running locally.
    if (mode === 'scheduled') {
      const sub = await Subscription.create({
        tenantId: tenant._id, tenantType: tenantType, planId: plan._id, tenure,
        status: 'scheduled', startDate, endDate,
        capabilities: capsToObject(plan.capabilities), // snapshot limits at purchase
        history: [{ action: 'created', toPlanId: plan._id, note: `Upcoming ${plan.name} (${tenure}) offline plan scheduled. It will automatically activate on ${startDate.toLocaleDateString('en-IN')}.`, performedBy, date: now }],
      });
      return { subscription: sub, mode, creditPaise, amountPaise };
    }

    // new / upgraded → supersede current active/grace/free locally, start now.
    for (const c of current) {
      c.status = 'expired';
      c.history.push({
        action: mode === 'upgraded' ? 'upgraded' : 'cancelled',
        toPlanId: plan._id,
        note: mode === 'upgraded' ? `Superseded by upgrade to ${plan.name}.` : `Superseded by new ${plan.name} plan.`,
        performedBy, date: now,
      } as any);
      await c.save();
    }

    const subscription = await Subscription.create({
      tenantId: tenant._id, tenantType: tenantType, planId: plan._id, tenure,
      status: 'active', startDate, endDate,
      capabilities: capsToObject(plan.capabilities), // snapshot limits at purchase
      history: [{
        action: mode === 'upgraded' ? 'upgraded' : 'cash_plan_assigned',
        toPlanId: plan._id,
        note: note || (mode === 'upgraded'
          ? `Upgraded to ${plan.name} (${tenure}) immediately. Unused balance of ₹${(creditPaise / 100).toFixed(2)} credited.`
          : `Activated new ${plan.name} (${tenure}) offline plan immediately.`),
        performedBy, date: now,
      }],
    });
    return { subscription, mode, creditPaise, amountPaise };
  }

  /** Activates a society from a PAID online payment link (webhook + poll fallback). Idempotent. */
  private static async processPaidLinkInvoice(invoice: IInvoice, paymentId?: string) {
    if (invoice.status === 'PAID') return;
    const actualTenantType = invoice.tenantType || 'SOCIETY';
    const [plan, tenant] = await Promise.all([
      Plan.findById(invoice.planId),
      actualTenantType === 'SHOP' ? Shop.findById(invoice.tenantId) : Society.findById(invoice.tenantId),
    ]);
    if (!plan || !tenant) return;

    const { subscription, creditPaise } = await BillingController.applyPlanChange(tenant, actualTenantType, plan, invoice.tenure || 'monthly', 'Online Payment');

    invoice.status = 'PAID';
    invoice.paidAt = new Date();
    invoice.subscriptionId = subscription._id as mongoose.Types.ObjectId;
    if (paymentId) invoice.razorpayPaymentId = paymentId;
    invoice.creditApplied = creditPaise;
    await invoice.save();

    const { email, name } = await resolveTenantEmail(tenant._id as mongoose.Types.ObjectId, actualTenantType);
    try {
      await InvoiceService.generateCustomInvoice(invoice, subscription, plan, {
        societyName: name || tenant.name, recipientEmail: email, tenure: invoice.tenure || 'monthly',
        recordedByName: 'Online Payment', creditApplied: creditPaise, currency: plan.currency,
      });
    } catch (e: any) {
      logger.error(`PDF generation for paid link invoice ${invoice._id} failed: ${e.message}`);
    }
    if (email) EmailService.sendPaymentReceiptEmail(email, name || tenant.name, plan.name, invoice.amount, invoice.tenure || 'monthly');
    logger.info(`Payment-link invoice ${invoice._id} processed & plan activated.`);
  }

  /**
   * Idempotently marks an invoice PAID and activates/creates its subscription.
   * Used by the client verify endpoint and the webhook (first charge).
   */
  private static async activateFromInvoice(invoice: IInvoice, paymentId: string | undefined, performedBy: string, razorpaySubscriptionId?: string) {
    if (invoice.status === 'PAID' && invoice.subscriptionId) {
      return Subscription.findById(invoice.subscriptionId);
    }

    const actualTenantType = invoice.tenantType || 'SOCIETY';
    const [plan, tenant] = await Promise.all([
      Plan.findById(invoice.planId),
      actualTenantType === 'SHOP' ? Shop.findById(invoice.tenantId) : Society.findById(invoice.tenantId),
    ]);
    if (!plan || !tenant) throw new Error('Plan or Tenant not found');

    const { subscription, creditPaise } = await BillingController.applyPlanChange(tenant, actualTenantType, plan, invoice.tenure || 'monthly', performedBy);

    // Attach razorpay subscription ID to the newly created local subscription
    const finalRzpSubId = razorpaySubscriptionId || invoice.razorpaySubscriptionId;
    if (finalRzpSubId) {
      subscription.razorpaySubscriptionId = finalRzpSubId;
      await subscription.save();
    }

    invoice.status = 'PAID';
    invoice.paidAt = new Date();
    invoice.subscriptionId = subscription._id as mongoose.Types.ObjectId;
    if (paymentId) invoice.razorpayPaymentId = paymentId;
    invoice.creditApplied = creditPaise;
    
    // Improve invoice series
    if (!invoice.customInvoiceNumber || invoice.customInvoiceNumber.startsWith('INV-17')) {
       const date = new Date();
       const year = date.getFullYear();
       const randomSuffix = Math.floor(1000 + Math.random() * 9000);
       invoice.customInvoiceNumber = `INV-${year}-${randomSuffix}`;
    }
    
    await invoice.save();

    const { email, name } = await resolveTenantEmail(invoice.tenantId, invoice.tenantType);
    try {
      invoice.customPdfUrl = await InvoiceService.generateCustomInvoice(invoice, subscription, plan, {
        societyName: name || tenant.name, recipientEmail: email, tenure: invoice.tenure || 'monthly',
        recordedByName: performedBy, creditApplied: creditPaise, currency: plan.currency,
      });
      await invoice.save();
    } catch (e: any) {
      logger.error(`PDF generation for online invoice ${invoice._id} failed: ${e.message}`);
    }

    if (email) EmailService.sendPaymentReceiptEmail(email, name || tenant.name, plan.name, invoice.amount, invoice.tenure || 'monthly');

    return subscription;
  }

  /**
   * Handles a `subscription.charged` event: activates on first charge, or records
   * a renewal invoice and extends the period on subsequent charges.
   */
  private static async handleSubscriptionCharged(rzpSubId: string, paymentId?: string) {
    // De-dupe by payment id.
    if (paymentId && (await Invoice.findOne({ razorpayPaymentId: paymentId }))) return;

    const localSub = await Subscription.findOne({ razorpaySubscriptionId: rzpSubId }).sort({ createdAt: -1 });

    if (!localSub) {
      // First charge may arrive before the client verify call — activate from the pending invoice.
      const pending = await Invoice.findOne({ razorpaySubscriptionId: rzpSubId, status: 'PENDING' });
      if (pending) await BillingController.activateFromInvoice(pending, paymentId, 'razorpay-webhook', rzpSubId);
      return;
    }

    const plan = await Plan.findById(localSub.planId);
    const pricing = plan?.getPricingForTenure(localSub.tenure);
    const months = pricing?.durationMonths || 1;

    await Invoice.create({
      tenantId: localSub.tenantId,
      tenantType: localSub.tenantType,
      subscriptionId: localSub._id,
      planId: localSub.planId,
      tenure: localSub.tenure,
      invoiceType: 'ONLINE_RAZORPAY',
      amount: (pricing?.totalPrice || 0) * 100,
      status: 'PAID',
      paidAt: new Date(),
      razorpayPaymentId: paymentId,
      razorpaySubscriptionId: rzpSubId,
    });

    // If it was scheduled, the first charge pays for the already-added term, so we just activate it without extending.
    if (localSub.status !== 'scheduled') {
      const base = localSub.endDate > new Date() ? new Date(localSub.endDate) : new Date();
      base.setMonth(base.getMonth() + months);
      localSub.endDate = base;
    }
    
    localSub.status = 'active';
    localSub.history.push({ action: 'renewed', note: 'Auto-charged by Razorpay', performedBy: 'razorpay-webhook', date: new Date() } as any);
    await localSub.save();

    if (plan && localSub.tenantType === 'SOCIETY') {
      const { email, name } = await resolveTenantEmail(localSub.tenantId, localSub.tenantType);
      if (email) EmailService.sendPaymentReceiptEmail(email, name, plan.name, (pricing?.totalPrice || 0) * 100, localSub.tenure);
    }
  }

  /**
   * OWNER: Generates a Razorpay Payment Link to renew a tenant's current plan.
   * Auto-detects the tenant's active plan and tenure — no manual plan selection needed.
   * The payment link is emailed to the tenant and the URL is returned to the owner.
   * When the tenant pays, the `payment_link.paid` webhook auto-activates the renewal
   * through the existing `processPaidLinkInvoice` pipeline.
   */
  static async generateRenewalLink(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = generateRenewalLinkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });

      const { societyId, shopId, tenantId, tenantType } = parsed.data;
      const actualTenantId = tenantId || shopId || societyId;
      const actualTenantType = tenantType || (shopId ? 'SHOP' : 'SOCIETY');

      if (!actualTenantId) return res.status(400).json({ success: false, message: 'Tenant ID is required' });
      if (!isRazorpayConfigured()) {
        return res.status(503).json({ success: false, message: 'Online payments are not configured. Please set up Razorpay keys first.' });
      }

      // Resolve tenant
      const tenant = actualTenantType === 'SHOP'
        ? await Shop.findById(actualTenantId)
        : await Society.findById(actualTenantId);
      if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

      // Find the active paid subscription
      const activeSub = await Subscription.findOne({
        tenantId: new mongoose.Types.ObjectId(String(actualTenantId)),
        tenantType: actualTenantType,
        isFreeTier: { $ne: true },
        status: { $in: ['active', 'past_due'] },
      }).sort({ endDate: -1 }).populate('planId');

      if (!activeSub || !activeSub.planId) {
        return res.status(400).json({ success: false, message: 'No active paid subscription found for this tenant. Use "Upgrade / Assign Plan" instead.' });
      }

      const plan = await Plan.findById(activeSub.planId);
      if (!plan) return res.status(404).json({ success: false, message: 'The subscription\'s plan no longer exists.' });

      const tenure = activeSub.tenure || 'monthly';
      const pricing = plan.getPricingForTenure(tenure);
      if (!pricing) return res.status(400).json({ success: false, message: `Tenure "${tenure}" is no longer available for this plan.` });

      const amountPaise = pricing.totalPrice * 100;
      if (amountPaise <= 0) return res.status(400).json({ success: false, message: 'Renewal amount is zero — nothing to charge.' });

      // Resolve recipient email
      let recipientEmail = actualTenantType === 'SHOP' ? (tenant as any).adminEmail : (tenant as any).contactEmail;
      if (!recipientEmail && tenant.adminUserId) {
        const adminUser = await User.findById(tenant.adminUserId).select('email').lean();
        recipientEmail = adminUser?.email;
      }
      if (!recipientEmail) {
        return res.status(400).json({ success: false, message: 'This tenant has no contact email. Add one before generating a payment link.' });
      }

      const performedBy = req.user?.userName || 'Owner';

      // Create a PENDING invoice
      const invoice = await Invoice.create({
        tenantId: new mongoose.Types.ObjectId(String(actualTenantId)),
        tenantType: actualTenantType,
        planId: plan._id,
        tenure,
        invoiceType: 'ONLINE_RAZORPAY',
        amount: amountPaise,
        status: 'PENDING',
        recordedById: req.user?.userId,
        recordedByName: performedBy,
        customInvoiceNumber: `INV-${Date.now()}`,
      });

      // Create Razorpay Payment Link
      const link = await RazorpayService.createPaymentLink({
        amountPaise,
        description: `${plan.name} (${tenure}) Renewal — ${tenant.name}`,
        customer: {
          name: (tenant as any).contactName || tenant.name,
          email: recipientEmail,
          contact: (tenant as any).contactPhone || (tenant as any).contactNumber,
        },
        notes: {
          invoiceId: invoice._id.toString(),
          societyId: String(actualTenantId),
          tenantType: actualTenantType,
        },
      });

      invoice.razorpayPaymentLinkId = link.id;
      invoice.razorpayPaymentLinkUrl = (link as any).short_url;
      await invoice.save();

      // Email the link to the tenant
      EmailService.sendPaymentLinkEmail(recipientEmail, tenant.name, plan.name, amountPaise, (link as any).short_url);

      auditBilling(req, String(actualTenantId), 'SUBSCRIPTION_RENEWAL_LINK', invoice._id.toString(), {
        tenantType: actualTenantType, plan: plan.name, tenure, amount: amountPaise,
        sentTo: recipientEmail, link: (link as any).short_url, generatedBy: performedBy,
      });

      return res.status(200).json({
        success: true,
        message: `Renewal link sent to ${recipientEmail}. The plan will renew automatically once they pay.`,
        paymentLinkUrl: (link as any).short_url,
        invoiceId: invoice._id,
        amount: amountPaise,
      });
    } catch (error: any) {
      logger.error(`generateRenewalLink failed: ${error.message}`);
      next(error);
    }
  }
}

export default BillingController;
