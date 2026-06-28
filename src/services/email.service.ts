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
<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#eef2f7;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader || ''}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,0.08);font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:${BRAND};background-image:linear-gradient(135deg,#0a5bd7,#2691f5);padding:22px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.3px;">${appConfig.appName}</span>
          <span style="color:#dbeafe;font-size:11px;float:right;padding-top:6px;">Society &amp; Shop Management</span>
        </td></tr>
        <tr><td style="height:4px;background:${accent};"></td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px;color:#0f172a;font-size:21px;font-weight:800;">${opts.heading}</h1>
          ${opts.body}
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #eef2f7;">
          <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
            Need help? Contact <a href="mailto:${appConfig.supportEmail}" style="color:${BRAND};text-decoration:none;">${appConfig.supportEmail}</a>.<br/>
            © ${new Date().getFullYear()} ${appConfig.appName}. All rights reserved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  }

  private static p(text: string): string {
    return `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.65;">${text}</p>`;
  }

  private static button(label: string, url: string, color = BRAND): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:10px;background:${color};">
      <a href="${url}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;">${label}</a>
    </td></tr></table>`;
  }

  private static infoBox(rows: Array<[string, string]>): string {
    const body = rows.map(([k, v]) =>
      `<tr><td style="padding:5px 0;color:#64748b;font-size:13px;width:130px;">${k}</td><td style="padding:5px 0;color:#0f172a;font-size:14px;font-weight:600;">${v}</td></tr>`
    ).join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;margin:8px 0 18px;">${body}</table>`;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  static sendWelcomeEmail(toEmail: string, userName: string): void {
    const html = this.layout({
      heading: `Welcome, ${userName}!`,
      preheader: `Welcome to ${appConfig.appName}`,
      body: this.p(`Your identity profile has been created successfully.`) +
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
        this.infoBox([['Email', toEmail], ['Password', passwordStr], ['Role', 'System Employee']]) +
        this.button('Log in', loginUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">We recommend changing your password after first login.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Your ${appConfig.appName} credentials`, html });
  }

  static sendEmployeeUpdatedEmail(toEmail: string, userName: string, designationName: string): void {
    const html = this.layout({
      heading: 'Your profile was updated',
      body: this.p(`Hi ${userName}, your profile on ${appConfig.appName} was updated by an administrator.`) +
        this.infoBox([['Active designation', designationName]]),
    });
    this.sendEmail({ to: toEmail, subject: `Profile updated — ${appConfig.appName}`, html });
  }

  static sendInvoiceEmail(toEmail: string, societyName: string, invoiceNumber: string, pdfUrl: string): void {
    const html = this.layout({
      heading: 'Payment recorded',
      accent: '#16a34a',
      body: this.p(`Hello ${societyName}, we've recorded your payment and generated invoice <strong>${invoiceNumber}</strong>.`) +
        this.button('Download Invoice (PDF)', pdfUrl) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">You can also download it any time from your billing dashboard.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `Invoice ${invoiceNumber} — ${appConfig.appName}`, html });
  }

  static sendSocietyApprovedEmail(toEmail: string, societyName: string, password: string): void {
    const loginLink = `${appConfig.frontendUrl}/login`;
    const html = this.layout({
      heading: 'Your society is approved 🎉',
      accent: '#16a34a',
      body: this.p(`<strong>${societyName}</strong> has been approved and activated.`) +
        this.infoBox([['Email', toEmail], ['Temporary password', password]]) +
        this.button('Log in', loginLink) +
        this.p(`<span style="color:#94a3b8;font-size:13px;">Please change your password immediately after logging in.</span>`),
    });
    this.sendEmail({ to: toEmail, subject: `"${societyName}" approved — ${appConfig.appName}`, html });
  }

  static sendSocietyPendingEmail(toEmail: string, societyName: string): void {
    const html = this.layout({
      heading: 'Registration received',
      body: this.p(`Thank you for registering <strong>${societyName}</strong>.`) +
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
        this.button('Renew Now', billingLink),
    });
    this.sendEmail({ to: toEmail, subject: `Your ${appConfig.appName} plan has expired`, html });
  }

  static sendPaymentLinkEmail(toEmail: string, societyName: string, planName: string, amountPaise: number, linkUrl: string): void {
    const amount = `₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const html = this.layout({
      heading: 'Complete your payment',
      body: this.p(`Hello ${societyName}, a payment of <strong>${amount}</strong> has been requested for the <strong>${planName}</strong> plan.`) +
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
        this.infoBox([['Plan', planName], ['Tenure', tenure], ['Amount', amount]]) +
        this.button('View Billing', billingLink),
    });
    this.sendEmail({ to: toEmail, subject: `Payment received — ${planName} active`, html });
  }
}

export default EmailService;
