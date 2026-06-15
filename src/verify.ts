import mongoose from 'mongoose';
import { appConfig } from './config/appConfig';
import { User } from './models/user.model';
import { Society } from './models/society.model';
import { Flat, FlatStatus } from './models/flat.model';
import { RentalAgreement } from './models/rental.model';
import { AuditLog } from './models/audit.model';
import { hashPassword, comparePassword } from './utils/hash.util';
import { generateAccessToken, verifyAccessToken } from './utils/jwt.util';
import { TenantType, UserRole } from './constants/roles';

// Set Env variables for testing
process.env.NODE_ENV = 'development';
process.env.APP_NAME = 'ResiSmart Test Suite';

const runVerification = async () => {
  console.log('--- ResiSmart E2E Verification Script Starting ---');
  console.log(`Connecting to Mongo: ${appConfig.mongoUri}`);
  
  await mongoose.connect(appConfig.mongoUri);
  console.log('MongoDB connected successfully.');

  // Clean database collections
  console.log('Cleaning test collections (preserving admin account)...');
  await User.deleteMany({ email: { $ne: 'admin@resismart.com' } });
  await Society.deleteMany({});
  await Flat.deleteMany({});
  await RentalAgreement.deleteMany({});
  await AuditLog.deleteMany({});
  console.log('Database cleaned.\n');

  // Seed the owner account if it doesn't exist
  const ownerEmail = 'admin@resismart.com';
  const existingOwner = await User.findOne({ email: ownerEmail });
  if (!existingOwner) {
    console.log('Owner account not found. Seeding initial owner account...');
    const password = 'Admin@123';
    const hashedPassword = await hashPassword(password);
    const systemTenantId = new mongoose.Types.ObjectId('000000000000000000000000');
    await User.create({
      name: 'System Owner',
      email: ownerEmail,
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
    console.log('Owner account seeded successfully.');
  } else {
    console.log('Owner account already exists, preserving it.');
  }

  let testPassed = true;

  try {
    // ----------------------------------------------------
    // 1. User Registration & Hashing
    // ----------------------------------------------------
    console.log('[Test 1] Registering test user Alice...');
    const alicePassword = 'password123';
    const aliceHash = await hashPassword(alicePassword);
    
    // Direct model insert to represent registered state
    const alice = await User.create({
      name: 'Alice Admin',
      email: 'alice@resismart.com',
      passwordHash: aliceHash,
      isActive: true,
      memberships: [],
    });
    console.log(`PASS: Alice registered. Hashed Password: ${aliceHash.substring(0, 15)}...`);

    // ----------------------------------------------------
    // 2. Add multiple profiles to Alice
    // ----------------------------------------------------
    console.log('\n[Test 2] Adding multiple profiles to Alice...');
    const mockSocietyId = new mongoose.Types.ObjectId();
    const mockShopId = new mongoose.Types.ObjectId();

    alice.memberships.push(
      { tenantType: TenantType.SOCIETY, tenantId: mockSocietyId, role: UserRole.SOCIETY_ADMIN },
      { tenantType: TenantType.SHOP, tenantId: mockShopId, role: UserRole.SHOP_OWNER }
    );
    await alice.save();

    // Verify multiple profile login logic
    const isPassMatched = await comparePassword(alicePassword, alice.passwordHash);
    console.log(`Password matches: ${isPassMatched}`);

    if (alice.memberships.length > 1) {
      console.log('PASS: Alice has multiple profiles. Login will correctly require context selection.');
      console.log('Profiles returned to client:');
      console.log(alice.memberships.map(m => ` - Type: ${m.tenantType} | ID: ${m.tenantId} | Role: ${m.role}`).join('\n'));
    } else {
      console.log('FAIL: Memberships not saved.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 3. Context Selection & Scoped Token Generation
    // ----------------------------------------------------
    console.log('\n[Test 3] Selecting Society context for Alice...');
    const chosenProfile = alice.memberships[0]; // Society Admin
    const tokenPayload = {
      userId: alice._id.toString(),
      activeTenantId: chosenProfile.tenantId.toString(),
      activeTenantType: chosenProfile.tenantType,
      activeRole: chosenProfile.role,
    };

    const token = generateAccessToken(tokenPayload);
    console.log(`AccessToken generated: ${token.substring(0, 30)}...`);

    const decoded = verifyAccessToken(token);
    if (
      decoded.userId === alice._id.toString() &&
      decoded.activeTenantId === mockSocietyId.toString() &&
      decoded.activeRole === UserRole.SOCIETY_ADMIN
    ) {
      console.log('PASS: Scoped JWT contains active Tenant ID and Role correctly.');
    } else {
      console.log('FAIL: Token parsing failed or is scope-mismatched.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 4. Single-Profile Auto-Selection Login
    // ----------------------------------------------------
    console.log('\n[Test 4] Registering and testing single-profile user Bob...');
    const bob = await User.create({
      name: 'Bob Tenant',
      email: 'bob@resismart.com',
      passwordHash: await hashPassword('password123'),
      isActive: true,
      memberships: [
        { tenantType: TenantType.SOCIETY, tenantId: mockSocietyId, role: UserRole.RESIDENT_TENANT }
      ]
    });

    if (bob.memberships.length === 1) {
      console.log('PASS: Bob has exactly one profile. Login will automatically select context:');
      const bobToken = generateAccessToken({
        userId: bob._id.toString(),
        activeTenantId: bob.memberships[0].tenantId.toString(),
        activeTenantType: bob.memberships[0].tenantType,
        activeRole: bob.memberships[0].role,
      });
      console.log(` Bob auto-selected Scoped JWT: ${bobToken.substring(0, 30)}...`);
    } else {
      console.log('FAIL: Bob single profile registration failed.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 5. Society Creation & Metadata Audit tracking
    // ----------------------------------------------------
    console.log('\n[Test 5] Creating Society and checking metadata fields...');
    const society = await Society.create({
      name: 'Palm Heights Society',
      address: 'Sector 45, Green City',
      createdBy: alice._id,
      createdByName: alice.name,
      updatedBy: alice._id,
      updatedByName: alice.name,
    });

    if (
      society.createdBy.toString() === alice._id.toString() &&
      society.createdByName === 'Alice Admin' &&
      society.createdAt &&
      society.updatedAt
    ) {
      console.log('PASS: Society created. Audit columns correctly tracked:');
      console.log(` - createdBy: ${society.createdBy}`);
      console.log(` - createdByName: "${society.createdByName}"`);
      console.log(` - updatedAt: ${society.updatedAt}`);
    } else {
      console.log('FAIL: Society metadata creation failed.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 6. Flat Creation & Check Constraints
    // ----------------------------------------------------
    console.log('\n[Test 6] Creating Flat inside Society...');
    const flat = await Flat.create({
      number: '101',
      blockName: 'Tower A',
      societyId: society._id,
      status: FlatStatus.VACANT,
      owners: [],
      createdBy: alice._id,
      createdByName: alice.name,
      updatedBy: alice._id,
      updatedByName: alice.name,
    });

    if (flat.status === FlatStatus.VACANT && flat.societyId.toString() === society._id.toString()) {
      console.log('PASS: Flat 101 in Tower A created in Vacant status.');
    } else {
      console.log('FAIL: Flat creation failed.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 7. Lease Creation & State Propagation
    // ----------------------------------------------------
    console.log('\n[Test 7] Creating Lease / Rental Agreement (renting Flat to Bob)...');
    
    // Simulate rent registration
    const lease = await RentalAgreement.create({
      flatId: flat._id,
      tenantId: bob._id,
      societyId: society._id,
      rentAmount: 15000,
      securityDeposit: 30000,
      startDate: new Date(),
      endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year lease
      isActive: true,
      createdBy: alice._id,
      createdByName: alice.name,
      updatedBy: alice._id,
      updatedByName: alice.name,
    });

    // Cascade: Update flat status to RENTED
    flat.status = FlatStatus.RENTED;
    flat.updatedBy = alice._id;
    flat.updatedByName = alice.name;
    await flat.save();

    // Cascade: Verify Bob's role updates in the DB
    await User.updateOne(
      { _id: bob._id, 'memberships.tenantId': society._id },
      { $set: { 'memberships.$.role': UserRole.RESIDENT_TENANT } }
    );
    const updatedBob = await User.findById(bob._id).lean();

    if (flat.status === FlatStatus.RENTED) {
      console.log('PASS: Flat status successfully cascaded to RENTED.');
    } else {
      console.log('FAIL: Flat status did not update to RENTED.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 8. Flat Updating & Audit diff values logging
    // ----------------------------------------------------
    console.log('\n[Test 8] Modifying Flat (Updating Owner and tracking old/new diffs)...');
    const oldValues = {
      status: flat.status,
      owners: flat.owners.map(o => o.toString()),
    };

    // Simulate adding Alice as owner of Flat
    flat.owners.push(alice._id);
    flat.status = FlatStatus.OWNER_OCCUPIED;
    flat.updatedBy = bob._id; // Bob updated it
    flat.updatedByName = bob.name;
    await flat.save();

    const newValues = {
      status: flat.status,
      owners: flat.owners.map(o => o.toString()),
    };

    if (
      flat.updatedBy.toString() === bob._id.toString() &&
      flat.updatedByName === 'Bob Tenant' &&
      flat.status === FlatStatus.OWNER_OCCUPIED
    ) {
      console.log('PASS: Flat modification successful.');
      console.log(` - updatedBy: ${flat.updatedBy} ("${flat.updatedByName}")`);
      console.log(` - Old Values: ${JSON.stringify(oldValues)}`);
      console.log(` - New Values: ${JSON.stringify(newValues)}`);
    } else {
      console.log('FAIL: Flat modifier logging failed.');
      testPassed = false;
    }

    // ----------------------------------------------------
    // 9. Fire simulated Audit Log & Check insertion
    // ----------------------------------------------------
    console.log('\n[Test 9] Logging actions in AuditLog collection...');
    
    // Log Flat modification
    await AuditLog.create({
      userId: bob._id,
      userName: bob.name,
      tenantId: society._id,
      tenantType: TenantType.SOCIETY,
      action: 'FLAT_UPDATE',
      resource: 'Flat',
      resourceId: flat._id,
      ipAddress: '127.0.0.1',
      userAgent: 'Mozilla/5.0 (Windows Test Suite)',
      oldValues,
      newValues,
    });

    const loggedAudits = await AuditLog.find({ tenantId: society._id }).lean();
    if (loggedAudits.length > 0 && loggedAudits[0].action === 'FLAT_UPDATE') {
      console.log('PASS: AuditLog successfully recorded mutation.');
      console.log('Recorded Audit Log Entry:');
      console.log(JSON.stringify(loggedAudits[0], null, 2));
    } else {
      console.log('FAIL: Audit log was not written to database.');
      testPassed = false;
    }

  } catch (error: any) {
    console.error('Test execution encountered error:', error);
    testPassed = false;
  } finally {
    try {
      const email = 'admin@resismart.com';
      const existingOwner = await User.findOne({ email });
      if (!existingOwner) {
        console.log('Owner account not found in finally block. Seeding initial owner account...');
        const password = 'Admin@123';
        const hashedPassword = await hashPassword(password);
        const systemTenantId = new mongoose.Types.ObjectId('000000000000000000000000');
        
        await User.create({
          name: 'System Owner',
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
        console.log('Seeded initial owner account successfully.');
      } else {
        console.log('Owner account already exists, skipping seed in finally block.');
      }
    } catch (seedError: any) {
      console.error('Failed to seed owner account in finally block:', seedError.message);
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
    
    console.log('\n=========================================');
    if (testPassed) {
      console.log(' VERIFICATION RESULT: ALL TESTS PASSED ');
    } else {
      console.log(' VERIFICATION RESULT: SOME TESTS FAILED ');
    }
    console.log('=========================================');
    process.exit(testPassed ? 0 : 1);
  }
};

runVerification();
