import mongoose from 'mongoose';
import { User } from './models/user.model';
import { Plan } from './models/plan.model';
import { GlobalSetting } from './models/global-setting.model';
import { hashPassword } from './utils/hash.util';
import { TenantType, UserRole } from './constants/roles';
import { connectDatabase } from './config/db';

const seedOwner = async (): Promise<void> => {
  const email = process.env.INITIAL_OWNER_EMAIL || 'admin@resismart.com';
  const password = process.env.INITIAL_OWNER_PASSWORD || 'Admin@123';
  const name = 'System Owner';
  const systemTenantId = new mongoose.Types.ObjectId('000000000000000000000000');

  const existingOwner = await User.findOne({ email });
  if (existingOwner) {
    existingOwner.passwordHash = await hashPassword(password);
    if (!existingOwner.memberships || existingOwner.memberships.length === 0) {
      existingOwner.memberships = [{ tenantType: TenantType.SYSTEM, tenantId: systemTenantId, role: UserRole.SYSTEM_OWNER }];
    }
    await existingOwner.save();
    console.log(`✔ System owner updated (${email})`);
    return;
  }

  const newOwner = await User.create({
    name,
    email,
    passwordHash: await hashPassword(password),
    isActive: true,
    memberships: [{ tenantType: TenantType.SYSTEM, tenantId: systemTenantId, role: UserRole.SYSTEM_OWNER }],
  });
  console.log(`✔ System owner created — ${newOwner.email} / ${password}`);
};

const seedSettings = async (): Promise<void> => {
  const existing = await GlobalSetting.findOne();
  if (existing) {
    console.log('✔ Global settings already present');
    return;
  }
  await GlobalSetting.create({
    gracePeriodDays: 7,
    defaultTrialCapabilities: {
      max_staff_count: 5,
      max_flat_count: 5,
      max_member_count: 20,
      max_visitor_count: 50,
      max_tickets_count: 20,
      max_service_count: 5,
    },
  });
  console.log('✔ Global settings seeded');
};

const seedPlans = async (): Promise<void> => {
  const plans = [
    {
      name: 'Starter',
      description: 'For small societies getting started.',
      basePrice: 999,
      isFeatured: false,
      capabilities: { max_flat_count: 100, max_staff_count: 10, max_member_count: 300, max_visitor_count: 1000, max_tickets_count: 300, max_service_count: 20 },
    },
    {
      name: 'Growth',
      description: 'For growing communities that need more capacity.',
      basePrice: 2499,
      isFeatured: true,
      capabilities: { max_flat_count: 500, max_staff_count: 50, max_member_count: 1500, max_visitor_count: 5000, max_tickets_count: 1500, max_service_count: 100 },
    },
    {
      name: 'Enterprise',
      description: 'Unlimited everything for large townships.',
      basePrice: 4999,
      isFeatured: false,
      capabilities: { max_flat_count: -1, max_staff_count: -1, max_member_count: -1, max_visitor_count: -1, max_tickets_count: -1, max_service_count: -1 },
    },
  ];

  for (const p of plans) {
    const exists = await Plan.findOne({ name: p.name });
    if (exists) continue;
    await Plan.create(p);
    console.log(`✔ Plan seeded — ${p.name}`);
  }
};

const run = async (): Promise<void> => {
  await connectDatabase();
  try {
    await seedOwner();
    await seedSettings();
    await seedPlans();
    console.log('\n========== SEED COMPLETE ==========');
    process.exit(0);
  } catch (error: any) {
    console.error('Seeding error:', error.message);
    process.exit(1);
  }
};

run();
