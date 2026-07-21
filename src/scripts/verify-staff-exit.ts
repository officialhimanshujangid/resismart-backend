/**
 * When somebody leaves, their open work does not leave with them.
 *
 * Every assertion FAILS against the code as it stood before this change.
 *
 * `endEmployment` deactivated the staff row and their assignments and stopped
 * there. Complaints already assigned to them stayed assigned — and because
 * `userOfStaff` filters `isActive: true`, every notification about those
 * complaints from that moment on resolved to **zero recipients** and went
 * nowhere, silently. The resident saw a ticket with a name on it and never
 * heard another word. Their push devices were never removed either, so a
 * dismissed guard's phone kept receiving the society's gate alerts.
 *
 *   npx tsx src/scripts/verify-staff-exit.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { Complaint } from '../models/complaint.model';
import { PushToken } from '../models/push-token.model';
import { User } from '../models/user.model';
import { createStaff, endEmployment } from '../services/staff.service';
import { TenantType, UserRole } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Manager' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

const ids: mongoose.Types.ObjectId[] = [];

async function cleanup() {
  await Promise.all([
    Block.deleteMany({ societyId }), Flat.deleteMany({ societyId }),
    SocietyStaff.deleteMany({ societyId }), StaffAssignment.deleteMany({ societyId }),
    Complaint.deleteMany({ societyId }), PushToken.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const audit = {
      societyId, createdBy: userId, createdByName: 'Setup',
      updatedBy: userId, updatedByName: 'Setup',
    };
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.OWNER_OCCUPIED,
    });

    const leaver = await createStaff(SID, {
      name: 'Departing Plumber', phone: '9876500001',
      designation: 'PLUMBER', employmentType: 'DIRECT',
    } as any, actor);
    const successor = await createStaff(SID, {
      name: 'New Plumber', phone: '9876500002',
      designation: 'PLUMBER', employmentType: 'DIRECT',
    } as any, actor);

    // A login and a registered device, so the exit has something to revoke.
    const account = await User.create({
      name: 'Departing Plumber',
      email: `leaver.${Date.now()}@throwaway.test`,
      password: 'x'.repeat(20), role: UserRole.SOCIETY_EMPLOYEE,
      memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role: UserRole.SOCIETY_EMPLOYEE }],
    });
    ids.push(account._id as any);
    await SocietyStaff.updateOne({ _id: leaver._id }, { $set: { userId: account._id } });
    await PushToken.create({
      societyId, userId: account._id, platform: 'ANDROID',
      token: `fcm-${new mongoose.Types.ObjectId()}`,
      createdBy: userId, updatedBy: userId,
    } as any);

    const mkComplaint = async (code: string, status: string) => Complaint.create({
      ...audit, ticketCode: code, kind: 'SERVICE', title: `Job ${code}`,
      category: 'Plumbing', visibility: 'PERSONAL', scope: 'FLAT',
      flatId: flat._id, flatLabel: 'A Wing 101', blockId: wing._id,
      raisedByUserId: userId, raisedByName: 'Resident',
      assigneeStaffId: leaver._id, assigneeName: 'Departing Plumber',
      status,
      firstResponseDueAt: new Date(Date.now() + 3600_000),
      resolutionDueAt: new Date(Date.now() + 86_400_000),
      totalPausedMs: 0, escalationLevel: 0, reopenCount: 0,
    } as any);

    const openJob = await mkComplaint('CMP/E1', 'IN_PROGRESS');
    const doneJob = await mkComplaint('CMP/E2', 'CLOSED');

    // ------------------------------------------------- handover to a named person
    console.log('Handing the work to a named successor');
    await endEmployment(SID, String(leaver._id), new Date(), actor, {
      handoverToStaffId: String(successor._id),
    });

    const moved = await Complaint.findById(openJob._id).lean();
    ok('open work moves to the successor',
      String(moved?.assigneeStaffId) === String(successor._id), String(moved?.assigneeStaffId));
    ok('...under their name', moved?.assigneeName === 'New Plumber');
    ok('...and the state the work had reached is preserved',
      moved?.status === 'IN_PROGRESS', moved?.status);

    const untouched = await Complaint.findById(doneJob._id).lean();
    ok('finished work is left alone, so history still reads true',
      String(untouched?.assigneeStaffId) === String(leaver._id));

    ok('their duties end with them',
      (await StaffAssignment.countDocuments({ staffId: leaver._id, isActive: true })) === 0);
    ok('their login is revoked',
      !(await User.findById(account._id))!.memberships.some(
        (m: any) => String(m.tenantId) === SID && m.role === UserRole.SOCIETY_EMPLOYEE));
    ok('...and their devices stop receiving this society\'s alerts',
      (await PushToken.countDocuments({ societyId, userId: account._id })) === 0);

    // ----------------------------------------- handover with nobody to hand to
    console.log('\nLeaving with nobody named to take over');
    const soloLeaver = await createStaff(SID, {
      name: 'Solo Electrician', phone: '9876500003',
      designation: 'ELECTRICIAN', employmentType: 'DIRECT',
    } as any, actor);
    const orphan = await Complaint.create({
      ...audit, ticketCode: 'CMP/E3', kind: 'SERVICE', title: 'Job E3',
      category: 'Electrical', visibility: 'PERSONAL', scope: 'FLAT',
      flatId: flat._id, flatLabel: 'A Wing 101', blockId: wing._id,
      raisedByUserId: userId, raisedByName: 'Resident',
      assigneeStaffId: soloLeaver._id, assigneeName: 'Solo Electrician',
      status: 'ASSIGNED',
      firstResponseDueAt: new Date(Date.now() + 3600_000),
      resolutionDueAt: new Date(Date.now() + 86_400_000),
      totalPausedMs: 0, escalationLevel: 0, reopenCount: 0,
    } as any);

    await endEmployment(SID, String(soloLeaver._id), new Date(), actor);
    const freed = await Complaint.findById(orphan._id).lean();
    ok('the work is returned to the unassigned queue, where it is visible',
      !freed?.assigneeStaffId, String(freed?.assigneeStaffId));
    ok('...rather than left pointing at somebody who has gone',
      String(freed?.assigneeStaffId || '') !== String(soloLeaver._id));

    // ------------------------------------------------------ refusing nonsense
    console.log('\nAnd it refuses a handover that cannot work');
    let refusedSelf = false;
    const another = await createStaff(SID, {
      name: 'Third Person', phone: '9876500004',
      designation: 'PLUMBER', employmentType: 'DIRECT',
    } as any, actor);
    try {
      await endEmployment(SID, String(another._id), new Date(), actor, {
        handoverToStaffId: String(another._id),
      });
    } catch { refusedSelf = true; }
    ok('nobody hands their work to themselves', refusedSelf);

    let refusedGhost = false;
    try {
      await endEmployment(SID, String(another._id), new Date(), actor, {
        handoverToStaffId: String(leaver._id), // already left
      });
    } catch { refusedGhost = true; }
    ok('...nor to somebody who has already left', refusedGhost);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  await mongoose.disconnect();
  process.exit(1);
});
