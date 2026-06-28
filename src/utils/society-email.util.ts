import mongoose from 'mongoose';
import { Society } from '../models/society.model';
import { User } from '../models/user.model';

/**
 * Resolves the best email address to notify for a society:
 * its captured contact email, falling back to the provisioned admin user's email.
 */
export async function resolveSocietyEmail(societyId: mongoose.Types.ObjectId | string): Promise<{ email?: string; name: string }> {
  const society = await Society.findById(societyId).select('name contactEmail adminUserId').lean();
  if (!society) return { email: undefined, name: 'Society' };
  if (society.contactEmail) return { email: society.contactEmail, name: society.name };
  if (society.adminUserId) {
    const user = await User.findById(society.adminUserId).select('email').lean();
    return { email: user?.email, name: society.name };
  }
  return { email: undefined, name: society.name };
}
