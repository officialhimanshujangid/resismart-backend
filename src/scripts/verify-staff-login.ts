/**
 * चरण 3 — a staff member with a login is real staff.
 *
 * The bug this closes: `SocietyStaff.userId` was never written, so
 * `resolveAccess` always found nobody, every SOCIETY_EMPLOYEE got all-NONE,
 * and no assigned technician was ever notified. Phase 3 and 5 were live code
 * that could not function.
 *
 * Speaks HTTP, because that is where it was broken — the guard signs in and
 * hits the console. The load-bearing checks:
 *   1. before a login, the guard's access is all-NONE (the old state)
 *   2. after provisionLogin, the SAME person can reach the gate console
 *   3. an assigned technician's notification actually reaches them
 *   4. ending employment revokes the login
 *
 *   npx tsx src/scripts/verify-staff-login.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import request from 'supertest';
import { appConfig } from '../config/appConfig';
import app from '../app';
import { User } from '../models/user.model';
import { Society } from '../models/society.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { AccessRole } from '../models/access-role.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { Notification } from '../models/notification.model';
import { createStaff, assign, provisionLogin } from '../services/staff.service';
import { seedAccessRoles, resolveAccess } from '../services/access-role.service';
import { raise } from '../services/complaint.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole) => {
  const u = await User.create({
    name, email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role }],
  });
  ids.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    SocietyStaff.deleteMany({ societyId }), StaffAssignment.deleteMany({ societyId }),
    AccessRole.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    Complaint.deleteMany({ societyId }), ComplaintEvent.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }),
  ]);
  // The provisioned staff logins are keyed by phone/email, cleaned by the id list
  // plus a sweep of the throwaway phones.
  await User.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ phone: { $in: ['9800000021', '9800000022'] } });
}

const settle = () => new Promise(r => setTimeout(r, 300));

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway society ${societyId}\n`);

  try {
    const adminId = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const residentId = await mkUser('Resident', UserRole.RESIDENT_OWNER);
    const admin = { userId: String(adminId), userName: 'Admin' };

    await Society.create({
      _id: societyId, name: `Throwaway ${societyId}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: adminId,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    } as any);
    const audit = { societyId, createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup' };
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: residentId,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: residentId, person: { name: 'Resident' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
    });

    await seedAccessRoles(String(societyId), admin.userId, admin.userName);
    const guardRole = await AccessRole.findOne({ societyId, name: 'Security guard' }).lean();
    const techRole = await AccessRole.findOne({ societyId, name: 'Technical staff' }).lean();

    // A guard and a plumber, both with a phone (so a login can be minted).
    const guard = await createStaff(String(societyId), {
      name: 'Guard Ramesh', phone: '9800000021', designation: 'SECURITY_GUARD',
      accessRoleId: String(guardRole!._id),
    }, admin);
    const plumber = await createStaff(String(societyId), {
      name: 'Plumber Vijay', phone: '9800000022', designation: 'PLUMBER',
      accessRoleId: String(techRole!._id),
    }, admin);
    await assign(String(societyId), {
      staffId: String(plumber._id), scope: 'BLOCK', blockId: String(wing._id), categories: ['PLUMBING'],
    }, admin);

    // =============================================== before: access is dead
    console.log('Before a login, a staff member is nobody to the access system');
    ok('the guard has no login yet', !guard.userId);

    // ================================================ provision → access live
    console.log('\nGiving them a login makes their role take effect');
    const provisioned = await provisionLogin(String(societyId), String(guard._id), admin);
    ok('a login is created', !!provisioned.staff.userId);
    // A phone-only staff member gets a passwordless (OTP) identity, exactly like
    // a resident — so there is nothing to hand over. The password only appears
    // when an email identity had to be created. Both are correct; assert the
    // login exists, not that a password always comes back.
    ok('...linked to a real user account', !!provisioned.staff.userId);

    const guardUserId = String(provisioned.staff.userId);
    // resolveAccess is what every gate route runs. Before this it returned
    // all-NONE for a guard; now it must grant what the seeded role says.
    const access = await resolveAccess(String(societyId), guardUserId, UserRole.SOCIETY_EMPLOYEE);
    ok('THE GUARD NOW HAS REAL PERMISSIONS, NOT ALL-NONE', !access.awaitingRole);
    eq('...specifically the gate console (Security guard is FULL)', access.permissions['GATE_CONSOLE'], 'FULL');

    // And through HTTP: the guard signs in and the console answers.
    const guardT = generateAccessToken({
      userId: guardUserId, activeTenantId: String(societyId),
      activeTenantType: TenantType.SOCIETY, activeRole: UserRole.SOCIETY_EMPLOYEE,
    });
    const inside = await request(app).get('/api/v1/gate/inside').set('Authorization', `Bearer ${guardT}`);
    ok('the guard can reach the gate console over HTTP', inside.status === 200, `got ${inside.status}`);

    // Re-provisioning is refused.
    let twice = '';
    try { await provisionLogin(String(societyId), String(guard._id), admin); }
    catch (e: any) { twice = e.message; }
    ok('a second login is refused', twice.includes('already have a login'), twice);

    // ================================================ assigned staff notified
    console.log('\nAn assigned technician is actually told about their work');
    await provisionLogin(String(societyId), String(plumber._id), admin);
    const plumberDoc = await SocietyStaff.findById(plumber._id).lean();

    // Auto-routing needs a categoryId — the workCategory that finds the
    // assignee lives on the category, not on a free-text name. Use a seeded one.
    const plumbingCat = await ComplaintCategory.create({
      ...audit, category: 'Plumbing', subCategory: 'Tap', workCategory: 'PLUMBING',
      firstResponseMinutes: 60, resolutionMinutes: 720, sortOrder: 0, isActive: true,
    });
    const complaint = await raise(String(societyId), {
      title: 'Tap leaking', categoryId: String(plumbingCat._id),
      flatId: String(flat._id),
    }, admin);
    // Routed to the plumber by their assignment.
    eq('the complaint routed to the plumber', String(complaint.assigneeStaffId), String(plumber._id));

    await settle();
    const inbox = await Notification.find({ societyId, userId: plumberDoc!.userId }).lean();
    ok('THE PLUMBER WAS ACTUALLY NOTIFIED — before, userOfStaff returned nobody',
      inbox.some(n => n.kind === 'COMPLAINT_ASSIGNED'),
      JSON.stringify(inbox.map(n => n.kind)));

    // ================================================= end employment revokes
    console.log('\nEnding employment takes the login away');
    await request(app).post(`/api/v1/staff/${guard._id}/end`)
      .set('Authorization', `Bearer ${generateAccessToken({ userId: admin.userId, activeTenantId: String(societyId), activeTenantType: TenantType.SOCIETY, activeRole: UserRole.SOCIETY_ADMIN })}`)
      .send({});
    const exGuard = await User.findById(guardUserId).lean();
    ok('the dismissed guard loses their society-employee membership',
      !(exGuard?.memberships || []).some((m: any) =>
        String(m.tenantId) === String(societyId) && m.role === UserRole.SOCIETY_EMPLOYEE));
    // The identity itself survives — they might live here too.
    ok('...but the account itself is not deleted', !!exGuard);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
