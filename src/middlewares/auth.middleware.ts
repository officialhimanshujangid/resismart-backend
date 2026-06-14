import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, ISecureJwtPayload } from '../utils/jwt.util';
import { UserRole } from '../constants/roles';
import { User } from '../models/user.model';

// Extend Express Request type to include user information
declare global {
  namespace Express {
    interface Request {
      user?: ISecureJwtPayload & { userName?: string };
    }
  }
}

export const authenticateJWT = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Access token missing or malformed' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    // Fetch user details from DB to verify user is active and resolve name (denormalized name cache)
    const user = await User.findById(decoded.userId).select('name isActive').lean();
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User is inactive or no longer exists' });
      return;
    }

    req.user = {
      ...decoded,
      userName: user.name,
    };

    next();
  } catch (error: any) {
    res.status(401).json({ error: 'Invalid or expired access token' });
  }
};

// Role authorization guard
export const authorizeRoles = (allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.activeRole) {
      res.status(401).json({ error: 'Authentication details missing from session' });
      return;
    }

    if (!allowedRoles.includes(req.user.activeRole)) {
      res.status(403).json({ error: 'Forbidden: You do not have permission to perform this action' });
      return;
    }

    next();
  };
};

// Tenant Scope Enforcer middleware
export const enforceTenantAccess = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user || !req.user.activeTenantId) {
    res.status(403).json({ error: 'Access denied: No active tenant context selected' });
    return;
  }
  next();
};
