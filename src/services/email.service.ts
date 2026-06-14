import nodemailer from 'nodemailer';
import { appConfig } from '../config/appConfig';
import { logger } from '../utils/logger.util';

class EmailService {
  private static getTransporter() {
    return nodemailer.createTransport({
      host: appConfig.smtpHost,
      port: appConfig.smtpPort,
      secure: false, // Port 2525 usually doesn't require SSL/TLS on connect, but uses STARTTLS
      auth: {
        user: appConfig.smtpUser,
        pass: appConfig.smtpPassword,
      },
    });
  }

  /**
   * Helper function to send emails asynchronously.
   */
  static sendEmail(options: { to: string; subject: string; html: string }): void {
    const transporter = this.getTransporter();

    const mailOptions = {
      from: `"${appConfig.smtpFromName}" <${appConfig.smtpFromEmail}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      replyTo: appConfig.smtpReplyTo,
    };

    // Send asynchronously in background to ensure fast API response speeds
    transporter.sendMail(mailOptions)
      .then((info) => {
        logger.info(`Email sent successfully to: ${options.to} | MessageId: ${info.messageId}`);
      })
      .catch((error) => {
        logger.error(`Failed to send email to ${options.to}: ${error.message}`);
      });
  }

  /**
   * Sends a welcome email upon user registration.
   */
  static sendWelcomeEmail(toEmail: string, userName: string): void {
    const subject = `Welcome to ${appConfig.appName}!`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #2D3748;">Welcome to ${appConfig.appName}, ${userName}!</h2>
        <p>Your identity profile has been successfully created.</p>
        <p>A platform administrator will assign your society or shop access roles shortly. Once roles are configured, you will be able to log in and select your workspace context.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #718096;">If you did not request this account, please ignore this email or contact us at <a href="mailto:${appConfig.supportEmail}">${appConfig.supportEmail}</a>.</p>
      </div>
    `;
    this.sendEmail({ to: toEmail, subject, html });
  }

  /**
   * Sends a notification when a user switches context or logs in.
   */
  static sendLoginNotification(toEmail: string, userName: string, contextName: string, role: string): void {
    const subject = `Security Alert: Login to ${appConfig.appName}`;
    const timestamp = new Date().toLocaleString();
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #2D3748;">Successful Login Alert</h2>
        <p>Hello ${userName},</p>
        <p>You have successfully logged into the <strong>${contextName}</strong> context as a <strong>${role}</strong>.</p>
        <p style="margin-top: 20px; font-size: 14px; background: #F7FAFC; padding: 10px; border-radius: 4px;">
          <strong>Time:</strong> ${timestamp}<br/>
          <strong>Branding:</strong> ${appConfig.appName}
        </p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #718096;">If this login was not performed by you, please reset your password immediately or contact <a href="mailto:${appConfig.supportEmail}">${appConfig.supportEmail}</a>.</p>
      </div>
    `;
    this.sendEmail({ to: toEmail, subject, html });
  }
}

export default EmailService;
