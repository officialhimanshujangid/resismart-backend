import nodemailer from 'nodemailer';
import { appConfig } from '../config/appConfig';
import { logger } from '../utils/logger.util';

const BRAND = '#0a5bd7';

class EmailService {
  private static getTransporter() {
    return nodemailer.createTransport({
      host: appConfig.smtpHost,
      port: appConfig.smtpPort,
      secure: false,
      auth: { user: appConfig.smtpUser, pass: appConfig.smtpPassword },
    });
  }

  static sendEmail(options: { to: string; subject: string; html: string }): void {
    const transporter = this.getTransporter();
    const mailOptions = {
      from: `"${appConfig.smtpFromName}" <${appConfig.smtpFromEmail}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      replyTo: appConfig.smtpReplyTo,
    };
    transporter.sendMail(mailOptions)
      .then((info) => logger.info(`Email sent to ${options.to} | ${info.messageId}`))
      .catch((error) => logger.error(`Failed to send email to ${options.to}: ${error.message}`));
  }

  // ── Shared building blocks ────────────────────────────────────────────────

  /** Branded, responsive shell used by every email. */
  private static layout(opts: {
    preheader?: string;
    accent?: string;
    heading: string;
    body: string; // inner HTML
  }): string {
    const accent = opts.accent || BRAND;
    return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    body { margin:0; padding:0; background-color:#f3f4f6; font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .email-wrapper { background-color:#f3f4f6; padding: 40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
    .email-header { background: linear-gradient(135deg, ${BRAND}, #3b82f6); padding: 32px 40px; text-align: left; }
    .email-header-title { color:#ffffff; font-size:24px; font-weight:800; letter-spacing:-0.5px; margin:0; }
    .email-header-subtitle { color:#dbeafe; font-size:12px; font-weight:500; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
    .email-accent-bar { height:4px; background-color:${accent}; width: 100%; }
    .email-body { padding: 40px; }
    .email-heading { margin:0 0 24px; color:#111827; font-size:24px; font-weight:800; letter-spacing:-0.5px; line-height: 1.25; }
    .email-footer { padding: 24px 40px; background-color:#f9fafb; border-top:1px solid #e5e7eb; text-align: center; }
    .email-footer-text { margin:0; color:#6b7280; font-size:13px; line-height:1.6; font-weight: 500; }
    .email-footer-link { color:${BRAND}; text-decoration:none; font-weight: 600; }
    @media only screen and (max-width: 600px) {
      .email-wrapper { padding: 20px 10px; }
      .email-body, .email-header, .email-footer { padding: 24px; }
    }
  </style>
</head>
<body>
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader || ''}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-wrapper">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-container">
        <tr><td class="email-header">
          <h1 class="email-header-title">${appConfig.appName}</h1>
          <div class="email-header-subtitle">Society &amp; Shop Management</div>
        </td></tr>
        <tr><td class="email-accent-bar"></td></tr>
        <tr><td class="email-body">
          <h2 class="email-heading">${opts.heading}</h2>
          ${opts.body}
        </td></tr>
        <tr><td class="email-footer">
          <p class="email-footer-text">
            Need help? Contact <a href="mailto:${appConfig.supportEmail}" class="email-footer-link">${appConfig.supportEmail}</a>.<br/><br/>
            &copy; ${new Date().getFullYear()} ${appConfig.appName}. All rights reserved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  }

  private static p(text: string): string {
    return `<p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.6;font-weight:400;">${text}</p>`;
  }

  private static button(label: string, url: string, color = BRAND): string {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 32px 0;">
        <tr>
          <td style="border-radius: 8px; background: ${color}; text-align: center;">
            <a href="${url}" style="display: inline-block; padding: 14px 28px; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); letter-spacing: 0.3px;">${label}</a>
          </td>
        </tr>
      </table>
    `;
  }

  private static infoBox(rows: Array<[string, string]>): string {
    const body = rows.map(([k, v]) =>
      `<tr>
        <td style="padding: 10px 0; color: #6b7280; font-size: 14px; font-weight: 500; width: 35%; border-bottom: 1px solid #f3f4f6;">${k}</td>
        <td style="padding: 10px 0; color: #111827; font-size: 15px; font-weight: 700; border-bottom: 1px solid #f3f4f6; text-align: right;">${v}</td>
      </tr>`
    ).join('');
    
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; margin: 24px 0; border-collapse: separate;">
        <tr><td style="padding: 16px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${body}
          </table>
        </td></tr>
      </table>
    `;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  static sendWelcomeEmail(toEmail: string, userName: string): void {
    const html = this.layout({
      heading: `Welcome, ${userName}!`,
      preheader: `Welcome to ${appConfig.appName}`,
      body: this.p(`Your identity profile has been created successfully.`) +
        this.infoBox([['Registered Email', toEmail], ['Status', 'Awaiting Assignment'], ['Registration Date', new Date().toLocaleDateString('en-GB')]]) +
        this.p(`A platform administrator will assign your society or shop access shortly. Once configured, you can log in and select your workspace.`),
    });
    this.sendEmail({ to: toEmail, subject: `Welcome to ${appConfig.appName}!`, html });
  }

  static sendLoginNotification(toEmail: string, userName: string, contextName: string, role: string): void {
    const html = this.layout({
      heading: 'New sign-in to your account',
      accent: '#f59e0b',
      body: this.p(`Hello ${userName}, you signed in to the <strong>${contextName}</strong> workspace as <strong>${role}</strong>.`) +
        this.infoBox([['Time', new Date().toLocaleString('en-GB')], ['Workspace', contextName], ['Role', role]]) +
        this.p(`If this wasn't you, please reset your password immediately.`),
    });
    this.sendEmail({ to: toEmail, subject: `Security alert: sign-in to ${appConfig.appName}`, html });
  }

  static sendPasswordResetEmail(toEmail: string, resetToken: string): void {
    const link = `${appConfig.frontendUrl}/reset-password?token=${resetToken}`;
    const html = this.layout({
      heading: 'Reset your password',
      body: this.p(`You requested a password reset. Click below to set a new password — the link expires in 1 hour.`) +
        this.infoBox([['Request Time', new Date().toLocaleString('en-GB')], ['Expires In', '1 Hour']]) +
        this.button('Reset Password', link) +
        this.p(`<span style="color:#94a3b8;font-size:13px;word-break:break-all;">Or paste this link: ${link}</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Password reset — ${appConfig.appName}`, html });
  }

  static sendEmployeeCreatedEmail(toEmail: string, userName: string, passwordStr: string, designationName: string): void {
    const loginUrl = `${appConfig.frontendUrl}/login`;
    const html = this.layout({
      heading: `Welcome to the team, ${userName}!`,
      body: this.p(`You've been added as <strong>${designationName}</strong>. Your login credentials are below.`) +
        this.infoBox([['Email', toEmail], ['Password', passwordStr], ['Role', 'System Employee'], ['Designation', designationName], ['Added On', new Date().toLocaleDateString('en-GB')]]) +
        this.button('Log in', loginUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">We recommend changing your password after first login.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Your ${appConfig.appName} credentials`, html });
  }

  static sendEmployeeUpdatedEmail(toEmail: string, userName: string, designationName: string): void {
    const html = this.layout({
      heading: 'Your profile was updated',
      body: this.p(`Hi ${userName}, your profile on ${appConfig.appName} was updated by an administrator.`) +
        this.infoBox([['Active designation', designationName], ['Update Time', new Date().toLocaleString('en-GB')]]),
    });
    this.sendEmail({ to: toEmail, subject: `Profile updated — ${appConfig.appName}`, html });
  }

  static sendInvoiceEmail(toEmail: string, societyName: string, invoiceNumber: string, pdfUrl: string): void {
    const html = this.layout({
      heading: 'Payment recorded',
      accent: '#16a34a',
      body: this.p(`Hello ${societyName}, we've recorded your payment and generated invoice <strong>${invoiceNumber}</strong>.`) +
        this.infoBox([['Entity Name', societyName], ['Invoice No.', invoiceNumber], ['Date Issued', new Date().toLocaleDateString('en-GB')]]) +
        this.button('Download Invoice (PDF)', pdfUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">The download link is valid for 7 days. You can also download it any time from your billing dashboard.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Invoice ${invoiceNumber} — ${appConfig.appName}`, html });
  }

  static sendSocietyApprovedEmail(toEmail: string, societyName: string, password: string): void {
    const loginLink = `${appConfig.frontendUrl}/login`;
    const html = this.layout({
      heading: 'Your registration is approved 🎉',
      accent: '#16a34a',
      body: this.p(`<strong>${societyName}</strong> has been approved and activated.`) +
        this.infoBox([['Registered Entity', societyName], ['Administrator Email', toEmail], ['Temporary password', password], ['Activation Date', new Date().toLocaleDateString('en-GB')]]) +
        this.button('Log in', loginLink) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">Please change your password immediately after logging in.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `"${societyName}" approved — ${appConfig.appName}`, html });
  }

  static sendSocietyPendingEmail(toEmail: string, societyName: string): void {
    const html = this.layout({
      heading: 'Registration received',
      body: this.p(`Thank you for registering <strong>${societyName}</strong>.`) +
        this.infoBox([['Registered Entity', societyName], ['Contact Email', toEmail], ['Expected Review SLA', '24-48 Hours']]) +
        this.p(`Your application is now <strong>pending review</strong>. We'll verify the details and email your login credentials once approved.`),
    });
    this.sendEmail({ to: toEmail, subject: `We received your registration for "${societyName}"`, html });
  }

  static sendSubscriptionExpiryReminder(toEmail: string, societyName: string, planName: string, daysLeft: number, endDate: Date): void {
    const billingLink = `${appConfig.frontendUrl}/dashboard/billing`;
    const end = new Date(endDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    const html = this.layout({
      heading: 'Your subscription is expiring soon',
      accent: '#f59e0b',
      body: this.p(`Hello ${societyName}, your <strong>${planName}</strong> plan ends in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong> (on ${end}).`) +
        this.infoBox([['Current Plan', planName], ['Expiry Date', end], ['Days Remaining', daysLeft.toString()], ['Post-Expiry Action', 'Downgrade to Free Tier']]) +
        this.p(`Renew now to avoid any interruption to your services.`) +
        this.button('Renew / Upgrade', billingLink),
    });
    this.sendEmail({ to: toEmail, subject: `Reminder: your ${appConfig.appName} plan expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, html });
  }

  static sendSubscriptionExpiredEmail(toEmail: string, societyName: string, planName: string): void {
    const billingLink = `${appConfig.frontendUrl}/dashboard/billing`;
    const html = this.layout({
      heading: 'Your plan has expired',
      accent: '#dc2626',
      body: this.p(`Hello ${societyName}, your <strong>${planName}</strong> plan has expired and your account has moved to the <strong>Free tier</strong>. Some features are now limited.`) +
        this.infoBox([['Previous Plan', planName], ['Expiry Date', new Date().toLocaleDateString('en-GB')], ['Current Status', 'Free Tier Restrictions Applied']]) +
        this.button('Renew Now', billingLink),
    });
    this.sendEmail({ to: toEmail, subject: `Your ${appConfig.appName} plan has expired`, html });
  }

  static sendPaymentLinkEmail(toEmail: string, societyName: string, planName: string, amountPaise: number, linkUrl: string): void {
    const amount = `₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const html = this.layout({
      heading: 'Complete your payment',
      body: this.p(`Hello ${societyName}, a payment of <strong>${amount}</strong> has been requested for the <strong>${planName}</strong> plan.`) +
        this.infoBox([['Plan Requested', planName], ['Total Amount Due', amount], ['Request Date', new Date().toLocaleDateString('en-GB')]]) +
        this.p(`Pay securely below — your plan activates automatically once payment is confirmed.`) +
        this.button(`Pay ${amount}`, linkUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;word-break:break-all;">Or open: ${linkUrl}</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Payment request — ${appConfig.appName} ${planName}`, html });
  }

  static sendPaymentReceiptEmail(toEmail: string, societyName: string, planName: string, amountPaise: number, tenure: string): void {
    const amount = `₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const billingLink = `${appConfig.frontendUrl}/dashboard/billing`;
    const html = this.layout({
      heading: 'Payment successful 🎉',
      accent: '#16a34a',
      body: this.p(`Hello ${societyName}, we've received your payment for the <strong>${planName}</strong> plan.`) +
        this.infoBox([['Plan Activated', planName], ['Tenure', tenure], ['Amount Paid', amount], ['Payment Date', new Date().toLocaleString('en-GB')]]) +
        this.button('View Billing', billingLink),
    });
    this.sendEmail({ to: toEmail, subject: `Payment received — ${planName} active`, html });
  }

  /**
   * Passwordless access notice — sent when a tenant identity (society admin,
   * flat owner, shop admin) is provisioned. No password: they log in with a
   * one-time code sent to their email or phone.
   */
  static sendTenantAccessEmail(toEmail: string, entityName: string, kind: 'society' | 'flat' | 'shop', extraRows: Array<[string, string]> = []): void {
    const loginLink = `${appConfig.frontendUrl}/login`;
    const noun = kind === 'flat' ? 'flat/plot' : kind;
    const html = this.layout({
      heading: `You have access to your ${noun} 🎉`,
      accent: '#16a34a',
      body: this.p(`Your ${noun} <strong>${entityName}</strong> is ready in ${appConfig.appName}.`) +
        this.infoBox([[kind === 'shop' ? 'Shop' : kind === 'flat' ? 'Flat/Plot' : 'Society', entityName], ['Sign-in', toEmail], ...extraRows]) +
        this.p(`No password needed — just log in with your <strong>email or phone number</strong> and we'll send a one-time code to verify it.`) +
        this.button('Log in', loginLink),
    });
    this.sendEmail({ to: toEmail, subject: `Access ready — ${entityName} — ${appConfig.appName}`, html });
  }

  static sendFlatOwnerCreatedEmail(toEmail: string, ownerName: string, flatNumber: string, blockName: string, societyName: string, passwordStr: string): void {
    const loginUrl = `${appConfig.frontendUrl}/login`;
    const html = this.layout({
      heading: `Welcome to ${societyName}!`,
      body: this.p(`Hi ${ownerName}, your flat portal has been created. Your login credentials are below.`) +
        this.infoBox([['Flat', flatNumber], ['Block', blockName], ['Society', societyName], ['Email', toEmail], ['Password', passwordStr]]) +
        this.button('Log in', loginUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">We strongly recommend changing your password after your first login.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Your Flat Portal is ready — ${appConfig.appName}`, html });
  }

  static sendResidentCreatedEmail(toEmail: string, residentName: string, flatNumber: string, societyName: string, passwordStr: string): void {
    const loginUrl = `${appConfig.frontendUrl}/login`;
    const html = this.layout({
      heading: `You've been added to a Flat`,
      body: this.p(`Hi ${residentName}, you've been added as a resident of Flat <strong>${flatNumber}</strong> in <strong>${societyName}</strong>.`) +
        this.infoBox([['Email', toEmail], ['Password', passwordStr]]) +
        this.button('Log in', loginUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">Please change your password immediately after logging in.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `You've been added as a resident — ${appConfig.appName}`, html });
  }

  /**
   * Sent when a NEW unit (flat/plot/shop) is linked to an already-registered
   * account. No password is issued — the user logs in with their existing one
   * and the new unit appears in their workspace switcher.
   */
  static sendUnitAddedEmail(
    toEmail: string,
    userName: string,
    unitLabel: string,
    tenantName: string,
    kind: 'flat' | 'plot' | 'shop' = 'flat'
  ): void {
    const loginUrl = `${appConfig.frontendUrl}/login`;
    const kindTitle = kind.charAt(0).toUpperCase() + kind.slice(1);
    const html = this.layout({
      heading: `A new ${kind} was added to your account`,
      accent: '#16a34a',
      body: this.p(`Hi ${userName}, a new ${kind} has been linked to your existing ${appConfig.appName} account.`) +
        this.infoBox([[kindTitle, unitLabel], [kind === 'shop' ? 'Shop' : 'Society', tenantName], ['Email', toEmail]]) +
        this.p(`Just log in with your <strong>existing password</strong> — no new credentials are needed. After signing in, use the workspace switcher to move between your units.`) +
        this.button('Log in', loginUrl),
    });
    this.sendEmail({ to: toEmail, subject: `New ${kind} added to your account — ${appConfig.appName}`, html });
  }

  /** One-time verification code, delivered to the real inbox (email channel is never shown on screen). */
  static sendOtpEmail(toEmail: string, code: string, ttlMinutes: number): void {
    const html = this.layout({
      heading: 'Verify your email address',
      preheader: `Your ${appConfig.appName} verification code`,
      body: this.p(`Use the code below to verify this email address. It expires in ${ttlMinutes} minutes.`) +
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
           <tr><td style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:18px 28px;
             font-size:32px;font-weight:800;letter-spacing:10px;color:#0f172a;text-align:center;">${code}</td></tr>
         </table>` +
        this.p(`<span style="color:#94a3b8;font-size:13px;">If you didn't request this, you can safely ignore this email.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `${code} is your ${appConfig.appName} verification code`, html });
  }
}

export default EmailService;
