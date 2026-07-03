import { Router } from 'express';
import {
  getShops,
  getShopStats,
  getShopById,
  registerShopPublic,
  registerShopAdmin,
  updateShop,
  approveShop,
  rejectShop,
  getMyShop,
  updateMyShop,
} from '../controllers/shop.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import mongoose from 'mongoose';
import { UserRole } from '../constants/roles';

const router = Router();

const OWNER = [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE];

// --- Public self-registration (landing page) ---
router.post('/register-public', registerShopPublic);

// --- Shop Admin (own shop) ---
router.get('/me/shop', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SHOP_ADMIN]), getMyShop);
router.put('/me/shop', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SHOP_ADMIN]), updateMyShop);

// --- Owner shop management ---
router.post('/register-admin', authenticateJWT, authorizeRoles(OWNER), registerShopAdmin);
router.get('/', authenticateJWT, authorizeRoles(OWNER), getShops);
router.get('/stats', authenticateJWT, authorizeRoles(OWNER), getShopStats);

// --- Owner: single shop + update + approve/reject ---
router.get('/:id', authenticateJWT, authorizeRoles(OWNER), getShopById);
router.put('/:id', authenticateJWT, authorizeRoles(OWNER), updateShop);
router.post('/:id/approve', authenticateJWT, authorizeRoles(OWNER), approveShop);
router.post('/:id/reject', authenticateJWT, authorizeRoles(OWNER), rejectShop);

export default router;
