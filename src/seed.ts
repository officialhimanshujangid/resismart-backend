import mongoose from 'mongoose';
import { User } from './models/user.model';
import { hashPassword } from './utils/hash.util';
import { TenantType, UserRole } from './constants/roles';
import { connectDatabase } from './config/db';

const seedInitialOwner = async (): Promise<void> => {
  // Connect to the database
  await connectDatabase();

  const email = process.env.INITIAL_OWNER_EMAIL || 'admin@resismart.com';
  const password = process.env.INITIAL_OWNER_PASSWORD || 'Admin@123';
  const name = 'System Owner';

  try {
    const existingOwner = await User.findOne({ email });

    if (existingOwner) {
      console.log('System owner account already exists. Updating password to current INITIAL_OWNER_PASSWORD...');
      const hashedPassword = await hashPassword(password);
      existingOwner.passwordHash = hashedPassword;
      
      // Ensure memberships are active
      if (!existingOwner.memberships || existingOwner.memberships.length === 0) {
        const systemTenantId = new mongoose.Types.ObjectId('000000000000000000000000');
        existingOwner.memberships = [
          {
            tenantType: TenantType.SYSTEM,
            tenantId: systemTenantId,
            role: UserRole.SYSTEM_OWNER,
          },
        ];
      }
      
      await existingOwner.save();
      console.log('System owner account updated successfully.');
      process.exit(0);
    }

    console.log('Hashing password...');
    const hashedPassword = await hashPassword(password);

    // Static system ObjectId for the tenantId to satisfy Mongoose requirements
    const systemTenantId = new mongoose.Types.ObjectId('000000000000000000000000');

    console.log('Creating System Owner user in database...');
    const newOwner = await User.create({
      name,
      email,
      passwordHash: hashedPassword,
      isActive: true,
      memberships: [
        {
          tenantType: TenantType.SYSTEM,
          tenantId: systemTenantId,
          role: UserRole.SYSTEM_OWNER,
        },
      ],
    });

    console.log('========================================================');
    console.log('   INITIAL OWNER SEEDED SUCCESSFULLY!                  ');
    console.log('========================================================');
    console.log(`  Name:     ${newOwner.name}`);
    console.log(`  Email:    ${newOwner.email}`);
    console.log(`  Password: ${password}`);
    console.log(`  Role:     ${UserRole.SYSTEM_OWNER}`);
    console.log('========================================================');
    process.exit(0);
  } catch (error: any) {
    console.error('Seeding encountered an error:', error.message);
    process.exit(1);
  }
};

seedInitialOwner();
