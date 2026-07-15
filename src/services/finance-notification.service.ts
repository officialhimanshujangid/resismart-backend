import EmailService from './email.service';
import { logger } from '../utils/logger.util';
import { ISocietyBill } from '../models/society-bill.model';
import { IBillPayment } from '../models/bill-payment.model';

export class FinanceNotificationService {

  /** Fire-and-forget branded email helper for finance events. */
  static async sendEmailSafe(to: string, subject: string, html: string) {
    if (!to) return;
    try {
      await EmailService.sendEmail({ to, subject, html: `${html}<br><p>Regards,<br>ResiSmart Team</p>` });
    } catch (e: any) {
      logger.error(`Finance email to ${to} failed: ${e.message}`);
    }
  }


  static async sendBillGeneratedEmail(to: string, name: string, bill: ISocietyBill) {
    if (!to) return;
    try {
      const amountStr = `₹${(bill.totalAmountPaise / 100).toLocaleString('en-IN')}`;
      const html = `
        <p>Dear ${name},</p>
        <p>A new bill <strong>${bill.billNumber}</strong> has been generated for your flat <strong>${bill.flatNumber}</strong>.</p>
        <p><strong>Description:</strong> ${bill.description}</p>
        <p><strong>Amount Due:</strong> ${amountStr}</p>
        <p><strong>Due Date:</strong> ${bill.dueDate.toLocaleDateString('en-IN')}</p>
        <p>Please login to your ResiSmart dashboard to view and pay your bill.</p>
        <br>
        <p>Regards,<br>ResiSmart Team</p>
      `;
      await EmailService.sendEmail({
        to,
        subject: `New Bill Generated: ${bill.description}`,
        html
      });
    } catch (e: any) {
      logger.error(`Failed to send bill generated email to ${to}: ${e.message}`);
    }
  }

  static async sendPaymentConfirmedEmail(to: string, name: string, payment: IBillPayment, bill: ISocietyBill) {
    if (!to) return;
    try {
      const amountStr = `₹${(payment.amountPaise / 100).toLocaleString('en-IN')}`;
      const html = `
        <p>Dear ${name},</p>
        <p>Your payment of <strong>${amountStr}</strong> for bill <strong>${bill.billNumber}</strong> has been confirmed.</p>
        <p><strong>Payment Method:</strong> ${payment.paymentMethod}</p>
        <p>Thank you for your prompt payment.</p>
        <br>
        <p>Regards,<br>ResiSmart Team</p>
      `;
      await EmailService.sendEmail({
        to,
        subject: `Payment Confirmed - ${bill.billNumber}`,
        html
      });
    } catch (e: any) {
      logger.error(`Failed to send payment confirmed email to ${to}: ${e.message}`);
    }
  }

  static async sendPaymentRejectedEmail(to: string, name: string, payment: IBillPayment, bill: ISocietyBill) {
    if (!to) return;
    try {
      const amountStr = `₹${(payment.amountPaise / 100).toLocaleString('en-IN')}`;
      const html = `
        <p>Dear ${name},</p>
        <p>Your reported offline payment of <strong>${amountStr}</strong> for bill <strong>${bill.billNumber}</strong> was <strong>rejected</strong>.</p>
        <p><strong>Reason:</strong> ${payment.rejectionReason || 'No reason provided'}</p>
        <p>Please login to your ResiSmart dashboard for more details or to submit a new payment.</p>
        <br>
        <p>Regards,<br>ResiSmart Team</p>
      `;
      await EmailService.sendEmail({
        to,
        subject: `Payment Rejected - ${bill.billNumber}`,
        html
      });
    } catch (e: any) {
      logger.error(`Failed to send payment rejected email to ${to}: ${e.message}`);
    }
  }

  static async sendOfflinePaymentPendingEmail(adminEmails: string[], payment: IBillPayment, flatNumber: string) {
    if (!adminEmails || adminEmails.length === 0) return;
    try {
      const amountStr = `₹${(payment.amountPaise / 100).toLocaleString('en-IN')}`;
      const html = `
        <p>Dear Admin/Committee,</p>
        <p>A new offline payment has been reported and is awaiting your confirmation.</p>
        <p><strong>Flat:</strong> ${flatNumber}</p>
        <p><strong>Amount:</strong> ${amountStr}</p>
        <p><strong>Method:</strong> ${payment.paymentMethod}</p>
        <p><strong>Reference:</strong> ${payment.referenceNote || 'N/A'}</p>
        <p>Please login to your ResiSmart dashboard to confirm or reject this payment.</p>
        <br>
        <p>Regards,<br>ResiSmart Team</p>
      `;
      
      for (const email of adminEmails) {
        if (email) {
          await EmailService.sendEmail({
            to: email,
            subject: `Pending Payment Confirmation - Flat ${flatNumber}`,
            html
          });
        }
      }
    } catch (e: any) {
      logger.error(`Failed to send pending payment email to admins: ${e.message}`);
    }
  }
}

export default FinanceNotificationService;
