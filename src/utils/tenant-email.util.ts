import mongoose from 'mongoose';
import { Society } from '../models/society.model';
import { Shop } from '../models/shop.model';
import { User } from '../models/user.model';

/**
 * Resolves the best email address to notify for a tenant:
 * its captured contact email, falling back to the provisioned admin user's email.
 */
export async function resolveTenantEmail(tenantId: mongoose.Types.ObjectId | string, tenantType: string = 'SOCIETY'): Promise<{ email?: string; name: string }> {
  if (tenantType === 'SHOP') {
    const shop = await Shop.findById(tenantId).select('name adminEmail adminUserId').lean();
    if (!shop) return { email: undefined, name: 'Shop' };
    if (shop.adminEmail) return { email: shop.adminEmail, name: shop.name };
    if (shop.adminUserId) {
      const user = await User.findById(shop.adminUserId).select('email').lean();
      return { email: user?.email, name: shop.name };
    }
    return { email: undefined, name: shop.name };
  } else {
    const society = await Society.findById(tenantId).select('name contactEmail adminUserId').lean();
    if (!society) return { email: undefined, name: 'Society' };
    if (society.contactEmail) return { email: society.contactEmail, name: society.name };
    if (society.adminUserId) {
      const user = await User.findById(society.adminUserId).select('email').lean();
      return { email: user?.email, name: society.name };
    }
    return { email: undefined, name: society.name };
  }
}
