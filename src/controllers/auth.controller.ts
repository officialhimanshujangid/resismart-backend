import { Request, Response, NextFunction } from 'express';
import { User } from '../models/user.model';
import { hashPassword, comparePassword } from '../utils/hash.util';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.util';
import { registerSchema, loginSchema, selectContextSchema, forgotPasswordSchema, resetPasswordSchema } from '../validators/auth.validator';
import crypto from 'crypto';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';
import EmailService from '../services/email.service';

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
    EmailService.sendWelcomeEmail(newUser.email, newUser.name);

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

    // Get user with passwordHash. Optimizing response times with lean query structure
    const user = await User.findOne({ email: validatedData.email }).exec();
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const isMatch = await comparePassword(validatedData.password, user.passwordHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const memberships = user.memberships;

    // CASE 1: No profiles registered
    if (!memberships || memberships.length === 0) {
      res.status(403).json({
        error: 'Your account does not have any active society or shop profiles. Please contact your administrator.',
      });
      return;
    }

    // CASE 2: Exactly 1 profile registered -> Auto-Select Context
    if (memberships.length === 1) {
      const activeProfile = memberships[0];
      const tokenPayload = {
        userId: user._id.toString(),
        activeTenantId: activeProfile.tenantId.toString(),
        activeTenantType: activeProfile.tenantType,
        activeRole: activeProfile.role,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(user._id.toString());

      // Audit Log logoff context
      AuditService.log({
        userId: user._id.toString(),
        userName: user.name,
        tenantId: activeProfile.tenantId,
        tenantType: activeProfile.tenantType,
        action: 'USER_LOGIN_AUTO_SELECT',
        resource: 'User',
        resourceId: user._id.toString(),
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
      });

      // Send Login Security Alert Email
      EmailService.sendLoginNotification(
        user.email,
        user.name,
        activeProfile.tenantType === TenantType.SOCIETY ? 'Society Context' : 'Shop Context',
        activeProfile.role
      );

      res.status(200).json({
        message: 'Login successful (context auto-selected)',
        autoSelected: true,
        token: accessToken,
        refreshToken: refreshToken,
        profile: {
          tenantType: activeProfile.tenantType,
          tenantId: activeProfile.tenantId,
          role: activeProfile.role,
        },
        user: {
          name: user.name,
          email: user.email,
        },
      });
      return;
    }

    // CASE 3: Multiple profiles -> Request context selection
    res.status(200).json({
      message: 'Multiple profiles found, please select context',
      autoSelected: false,
      requiresContextSelection: true,
      profiles: memberships.map((m) => ({
        tenantType: m.tenantType,
        tenantId: m.tenantId,
        role: m.role,
      })),
      userId: user._id,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const selectContext = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = selectContextSchema.parse(req.body);
    const authHeader = req.headers.authorization;
    
    // We expect the user to send their credentials/temporary identity token to perform switch context
    // For simplicity of this demonstration, we allow passing context selection requests by finding user via body `userId`
    const userId = req.body.userId;
    if (!userId) {
      res.status(400).json({ error: 'userId is required for context selection' });
      return;
    }

    const user = await User.findById(userId).exec();
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User does not exist or is inactive' });
      return;
    }

    // Validate that the user actually belongs to the chosen tenant context
    const matchingMembership = user.memberships.find(
      (m) => m.tenantId.toString() === validatedData.tenantId && m.role === validatedData.role
    );

    if (!matchingMembership) {
      res.status(403).json({ error: 'Unauthorized context selection request' });
      return;
    }

    const tokenPayload = {
      userId: user._id.toString(),
      activeTenantId: matchingMembership.tenantId.toString(),
      activeTenantType: matchingMembership.tenantType,
      activeRole: matchingMembership.role,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(user._id.toString());

    // Write audit log
    AuditService.log({
      userId: user._id.toString(),
      userName: user.name,
      tenantId: matchingMembership.tenantId,
      tenantType: matchingMembership.tenantType,
      action: 'USER_CONTEXT_SELECT',
      resource: 'User',
      resourceId: user._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    });

    // Send Login Security Alert Email
    EmailService.sendLoginNotification(
      user.email,
      user.name,
      matchingMembership.tenantType === TenantType.SOCIETY ? 'Society Context' : 'Shop Context',
      matchingMembership.role
    );

    res.status(200).json({
      message: 'Context context selected successfully',
      token: accessToken,
      refreshToken: refreshToken,
      profile: {
        tenantType: matchingMembership.tenantType,
        tenantId: matchingMembership.tenantId,
        role: matchingMembership.role,
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

export const refreshSessionToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { refreshToken, tenantId, role } = req.body;
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

    let activeProfile;

    if (tenantId && role) {
      activeProfile = user.memberships.find(
        (m) => m.tenantId.toString() === tenantId && m.role === role
      );
      if (!activeProfile) {
        res.status(403).json({ error: 'Unauthorized context request' });
        return;
      }
    } else if (user.memberships && user.memberships.length === 1) {
      activeProfile = user.memberships[0];
    }

    if (!activeProfile && user.memberships && user.memberships.length > 1) {
      res.status(200).json({
        message: 'Multiple profiles found, context selection required',
        requiresContextSelection: true,
        profiles: user.memberships.map((m) => ({
          tenantType: m.tenantType,
          tenantId: m.tenantId,
          role: m.role,
        })),
        userId: user._id,
      });
      return;
    }

    if (!activeProfile) {
      res.status(403).json({ error: 'Your account does not have any active society or shop profiles.' });
      return;
    }

    const tokenPayload = {
      userId: user._id.toString(),
      activeTenantId: activeProfile.tenantId.toString(),
      activeTenantType: activeProfile.tenantType,
      activeRole: activeProfile.role,
    };

    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(user._id.toString());

    res.status(200).json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      profile: {
        tenantType: activeProfile.tenantType,
        tenantId: activeProfile.tenantId,
        role: activeProfile.role,
      },
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
    EmailService.sendPasswordResetEmail(user.email, resetToken);

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
