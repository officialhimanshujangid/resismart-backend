import { Request, Response, NextFunction } from 'express';
import { User } from '../models/user.model';
import { hashPassword, comparePassword } from '../utils/hash.util';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.util';
import { registerSchema, loginSchema, loginOtpRequestSchema, loginOtpVerifySchema, forgotPasswordSchema, resetPasswordSchema } from '../validators/auth.validator';
import crypto from 'crypto';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';
import EmailService from '../services/email.service';
import { isEmail, normalizePhone } from '../utils/phone.util';
import { resolveUserContexts, toTokenPayload } from '../services/context.service';
import { requestOtp, verifyOtp, consumeVerification, OtpRateError, OtpInputError } from '../services/otp.service';

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = registerSchema.parse(req.body);
    
    // Check if user already exists
    const existingUser = await User.findOne({ email: validatedData.email }).lean();
    if (existingUser) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    const hashedPassword = await hashPassword(validatedData.password);
    
    // Create new user (by default, memberships are empty until added by an admin)
    const newUser = await User.create({
      name: validatedData.name,
      email: validatedData.email,
      passwordHash: hashedPassword,
      isActive: true,
      memberships: [],
    });

    // Fire audit log asynchronously
    AuditService.log({
      userId: newUser._id.toString(),
      userName: newUser.name,
      tenantId: null,
      tenantType: TenantType.SYSTEM,
      action: 'USER_REGISTER',
      resource: 'User',
      resourceId: newUser._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { email: newUser.email, name: newUser.name },
    });

    // Send Welcome Email
    if (newUser.email) EmailService.sendWelcomeEmail(newUser.email, newUser.name);

    res.status(201).json({
      message: 'User registered successfully. Admin must assign your role profiles.',
      userId: newUser._id,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const identifier = validatedData.identifier.trim();

    // Look up by email OR normalized phone number.
    const query = isEmail(identifier)
      ? { email: identifier.toLowerCase() }
      : { phone: normalizePhone(identifier) };

    const user = await User.findOne(query).exec();
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Passwordless tenant identities have no passwordHash — they must use OTP login.
    if (!user.passwordHash) {
      res.status(401).json({ error: 'This account signs in with a one-time code.', useOtp: true });
      return;
    }

    const isMatch = await comparePassword(validatedData.password, user.passwordHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Resolve every switchable unit (flats/plots/shops + admin roles).
    const contexts = await resolveUserContexts(user);

    if (contexts.length === 0) {
      res.status(403).json({
        error: 'Your account does not have any active society or shop profiles. Please contact your administrator.',
      });
      return;
    }

    // Auto-select the first (default) context; the rest populate the switcher.
    const active = contexts[0];
    const accessToken = generateAccessToken(toTokenPayload(user, active));
    const refreshToken = generateRefreshToken(user._id.toString());

    AuditService.log({
      userId: user._id.toString(),
      userName: user.name,
      tenantId: active.tenantId,
      tenantType: active.tenantType,
      action: 'USER_LOGIN_AUTO_SELECT',
      resource: 'User',
      resourceId: user._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    });

    if (user.email) EmailService.sendLoginNotification(user.email, user.name, active.tenantName, active.role);

    res.status(200).json({
      message: 'Login successful',
      autoSelected: true,
      token: accessToken,
      refreshToken,
      activeContext: active,
      availableContexts: contexts,
      // Legacy shape kept for older clients.
      profile: { tenantType: active.tenantType, tenantId: active.tenantId, role: active.role },
      user: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        profileImage: user.profileImage,
      },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

/**
 * POST /auth/login/otp/request — passwordless login for tenant identities.
 * Sends a LOGIN code only if an active identity with tenant access exists
 * (generic response otherwise, to avoid account enumeration).
 */
export const loginOtpRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { identifier } = loginOtpRequestSchema.parse(req.body);
    const id = identifier.trim();
    const channel: 'EMAIL' | 'PHONE' = isEmail(id) ? 'EMAIL' : 'PHONE';
    const target = channel === 'EMAIL' ? id.toLowerCase() : normalizePhone(id);

    const user = await User.findOne(channel === 'EMAIL' ? { email: target } : { phone: target }).exec();

    let devCode: string | undefined;
    if (user && user.isActive) {
      const contexts = await resolveUserContexts(user);
      if (contexts.length > 0) {
        try {
          const result = await requestOtp(channel, id, 'LOGIN');
          devCode = result.devCode;
        } catch (e) {
          if (e instanceof OtpRateError) { res.status(429).json({ error: e.message }); return; }
          if (e instanceof OtpInputError) { res.status(400).json({ error: e.message }); return; }
          throw e;
        }
      }
    }

    res.status(200).json({
      message: channel === 'EMAIL'
        ? 'If an account exists, a login code has been emailed.'
        : 'If an account exists, a login code has been sent.',
      channel,
      ...(devCode ? { devCode } : {}), // dev only (phone) — shown on the UI
    });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    next(error);
  }
};

/**
 * POST /auth/login/otp/verify — verify the LOGIN code, resolve the identity's
 * contexts, and issue a session (auto-selecting the first).
 */
export const loginOtpVerify = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { identifier, code } = loginOtpVerifySchema.parse(req.body);
    const id = identifier.trim();
    const channel: 'EMAIL' | 'PHONE' = isEmail(id) ? 'EMAIL' : 'PHONE';
    const target = channel === 'EMAIL' ? id.toLowerCase() : normalizePhone(id);

    const result = await verifyOtp(channel, id, 'LOGIN', code);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }

    const user = await User.findOne(channel === 'EMAIL' ? { email: target } : { phone: target }).exec();
    if (!user || !user.isActive) { res.status(403).json({ error: 'No account found for this contact.' }); return; }

    const contexts = await resolveUserContexts(user);
    if (contexts.length === 0) {
      res.status(403).json({ error: 'Your account does not have any active society or shop access yet.' });
      return;
    }

    await consumeVerification(channel, id, 'LOGIN'); // one-time

    const active = contexts[0];
    const accessToken = generateAccessToken(toTokenPayload(user, active));
    const refreshToken = generateRefreshToken(user._id.toString());

    AuditService.log({
      userId: user._id.toString(),
      userName: user.name,
      tenantId: active.tenantId,
      tenantType: active.tenantType,
      action: 'USER_LOGIN_OTP',
      resource: 'User',
      resourceId: user._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    });
    if (user.email) EmailService.sendLoginNotification(user.email, user.name, active.tenantName, active.role);

    res.status(200).json({
      message: 'Login successful',
      token: accessToken,
      refreshToken,
      activeContext: active,
      availableContexts: contexts,
      profile: { tenantType: active.tenantType, tenantId: active.tenantId, role: active.role },
      user: { name: user.name, email: user.email, phone: user.phone, profileImage: user.profileImage },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    next(error);
  }
};

export const refreshSessionToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { refreshToken, tenantId, role, contextId } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token is required' });
      return;
    }

    const decoded = verifyRefreshToken(refreshToken);
    const userId = decoded.userId;

    const user = await User.findById(userId).exec();
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User is inactive or no longer exists' });
      return;
    }

    const contexts = await resolveUserContexts(user);

    if (contexts.length === 0) {
      res.status(403).json({ error: 'Your account does not have any active society or shop profiles.' });
      return;
    }

    // Resolve the requested context: explicit contextId, legacy tenantId+role, else default first.
    let active;
    if (contextId) {
      active = contexts.find((c) => c.contextId === contextId);
      if (!active) {
        res.status(403).json({ error: 'Unauthorized context request' });
        return;
      }
    } else if (tenantId && role) {
      const matches = contexts.filter((c) => c.tenantId === tenantId && c.role === role);
      active = matches.find((c) => c.unitId) || matches[0];
      if (!active) {
        res.status(403).json({ error: 'Unauthorized context request' });
        return;
      }
    } else {
      active = contexts[0];
    }

    const newAccessToken = generateAccessToken(toTokenPayload(user, active));
    const newRefreshToken = generateRefreshToken(user._id.toString());

    res.status(200).json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      activeContext: active,
      availableContexts: contexts,
      profile: { tenantType: active.tenantType, tenantId: active.tenantId, role: active.role },
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
};

export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = forgotPasswordSchema.parse(req.body);
    const user = await User.findOne({ email: validatedData.email });
    
    // For security reasons, do not leak whether an email exists or not.
    if (!user) {
      res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });
      return;
    }

    // Generate a token; email the plaintext but persist only its hash so a DB
    // leak cannot be used to reset accounts.
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(Date.now() + 3600000); // 1 hour from now

    await user.save();

    // Send email with the plaintext token
    if (user.email) EmailService.sendPasswordResetEmail(user.email, resetToken);

    res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = resetPasswordSchema.parse(req.body);

    const hashedToken = crypto.createHash('sha256').update(validatedData.token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() }, // ensure token is not expired
    });

    if (!user) {
      res.status(400).json({ error: 'Password reset token is invalid or has expired.' });
      return;
    }

    // Hash new password
    user.passwordHash = await hashPassword(validatedData.password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).json({ message: 'Password has been reset successfully.' });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};
