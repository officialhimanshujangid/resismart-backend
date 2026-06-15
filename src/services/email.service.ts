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

  /**
   * Sends a password reset email.
   */
  static sendPasswordResetEmail(toEmail: string, resetToken: string): void {
    const subject = `Password Reset Request - ${appConfig.appName}`;
    // Assuming frontend runs on same host/port during dev, or a specific config.
    // We will construct a generic link. You can adjust the frontend URL based on env.
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;
    
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #2D3748;">Reset Your Password</h2>
        <p>You requested a password reset for your ${appConfig.appName} account.</p>
        <p>Please click the button below to set a new password. This link will expire in 1 hour.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #0a5bd7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block;">Reset Password</a>
        </div>
        <p style="word-break: break-all; color: #718096; font-size: 14px;">Or copy this link: <br/> ${resetLink}</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #718096;">If you did not request a password reset, please ignore this email.</p>
      </div>
    `;
    this.sendEmail({ to: toEmail, subject, html });
  }

  /**
   * Sends a notification when a new system employee profile is created.
   */
  static sendEmployeeCreatedEmail(
    toEmail: string,
    userName: string,
    passwordStr: string,
    designationName: string
  ): void {
    const subject = `Welcome to the Team! Your ${appConfig.appName} Credentials`;
    const loginLink = process.env.FRONTEND_URL || 'http://localhost:4444/login';
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <h2 style="color: #0a5bd7; margin-bottom: 5px;">Welcome to ${appConfig.appName}!</h2>
        <p style="color: #64748b; font-size: 14px; margin-top: 0;">Hi <strong>${userName}</strong>,</p>
        <p style="color: #334155; font-size: 15px; line-height: 1.5;">
          You have been added to the system as a <strong>${designationName}</strong>. 
          Your login credentials have been created successfully.
        </p>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 4px 0; color: #64748b; width: 100px;"><strong>Email:</strong></td>
              <td style="padding: 4px 0; color: #0f172a;">${toEmail}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0; color: #64748b;"><strong>Password:</strong></td>
              <td style="padding: 4px 0; color: #0f172a; font-family: monospace; font-size: 15px;"><strong>${passwordStr}</strong></td>
            </tr>
            <tr>
              <td style="padding: 4px 0; color: #64748b;"><strong>Role:</strong></td>
              <td style="padding: 4px 0; color: #0f172a;">System Employee</td>
            </tr>
          </table>
        </div>
        <p style="color: #334155; font-size: 14px;">Please click the link below to access your account. We recommend changing your password upon first login.</p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${loginLink}" style="background-color: #0a5bd7; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 12px rgba(10, 91, 215, 0.15);">Log In to ResiSmart</a>
        </div>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8;">If you believe this email was sent in error, please contact us at <a href="mailto:${appConfig.supportEmail}" style="color: #0a5bd7; text-decoration: none;">${appConfig.supportEmail}</a>.</p>
      </div>
    `;
    this.sendEmail({ to: toEmail, subject, html });
  }

  /**
   * Sends a notification when a system employee profile is updated.
   */
  static sendEmployeeUpdatedEmail(
    toEmail: string,
    userName: string,
    designationName: string
  ): void {
    const subject = `Your System Profile Has Been Updated - ${appConfig.appName}`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <h2 style="color: #0f172a; margin-bottom: 5px;">Profile Updated</h2>
        <p style="color: #64748b; font-size: 14px; margin-top: 0;">Hi <strong>${userName}</strong>,</p>
        <p style="color: #334155; font-size: 15px; line-height: 1.5;">
          Your profile details on <strong>${appConfig.appName}</strong> have been updated by a system administrator.
        </p>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 4px 0; color: #64748b; width: 130px;"><strong>Active Designation:</strong></td>
              <td style="padding: 4px 0; color: #0f172a; font-weight: bold;">${designationName}</td>
            </tr>
          </table>
        </div>
        <p style="color: #64748b; font-size: 14px;">If you have any questions or didn't request this update, please contact your system administrator or support.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8;">Support email: <a href="mailto:${appConfig.supportEmail}" style="color: #0a5bd7; text-decoration: none;">${appConfig.supportEmail}</a></p>
      </div>
    `;
    this.sendEmail({ to: toEmail, subject, html });
  }
}

export default EmailService;
