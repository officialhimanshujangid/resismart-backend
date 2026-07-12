import jwt from 'jsonwebtoken';
import { appConfig } from '../config/appConfig';
import { UserRole, TenantType } from '../constants/roles';

export interface ISecureJwtPayload {
  userId: string;
  activeTenantId?: string;
  activeTenantType?: TenantType;
  activeRole?: UserRole;
  // Unit-granular session: which flat/plot/shop inside the tenant is active.
  activeUnitType?: 'FLAT' | 'SHOP';
  activeUnitId?: string;
  activeContextId?: string;
}

export const generateAccessToken = (payload: ISecureJwtPayload): string => {
  return jwt.sign(payload, appConfig.jwtAccessSecret, {
    expiresIn: appConfig.jwtAccessExpiry as any,
  });
};

export const generateRefreshToken = (userId: string): string => {
  return jwt.sign({ userId }, appConfig.jwtRefreshSecret, {
    expiresIn: appConfig.jwtRefreshExpiry as any,
  });
};


export const verifyAccessToken = (token: string): ISecureJwtPayload => {
  return jwt.verify(token, appConfig.jwtAccessSecret) as ISecureJwtPayload;
};

export const verifyRefreshToken = (token: string): { userId: string } => {
  return jwt.verify(token, appConfig.jwtRefreshSecret) as { userId: string };
};
