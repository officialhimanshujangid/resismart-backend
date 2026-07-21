/**
 * Phase 7b — parking.
 *
 * Three things are worth proving and everything else in here is scaffolding
 * around them:
 *
 *   1. **The database refuses a second live allocation on one slot.** Not the
 *      service — the partial unique index. An application-level check passes
 *      this test and still loses the race that matters, so the assertion writes
 *      the second row directly and expects an 11000.
 *   2. **The bill is derived, not typed.** `Flat.quantities.parkingSlots` is
 *      recomputed on allocate AND on release, in the same transaction. This is
 *      the entire reason the module exists: before it, a flat with five cars and
 *      a hand-typed "2" was billed for two, forever.
 *   3. **A resident cannot see who holds a neighbour's slot.** The map's popover
 *      carries a flat, a name and a number plate; served to everybody it is a
 *      directory of who owns which car.
 *
 * Plus the wizard, the transfer, the waiting list, the reconciliation report
 * and the 404 a society that does not manage parking must get.
 *
 *   npx tsx src/scripts/verify-parking.ts
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
import { ResidentVehicle } from '../models/resident-vehicle.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { ParkingZone } from '../models/parking-zone.model';
import { ParkingSlot } from '../models/parking-slot.model';
import { ParkingAllocation } from '../models/parking-allocation.model';
import { ParkingRequest } from '../models/parking-request.model';
import * as parking from '../services/parking.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

const tokenFor = (userId: mongoose.Types.ObjectId, role: UserRole) =>
  generateAccessToken({
    userId: String(userId),
    activeTenantId: SID,
    activeTenantType: TenantType.SOCIETY,
    activeRole: role,
  });

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole) => {
  const u = await User.create({
    name,
    email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role }],
  });
  ids.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

/** What a flat is actually billed for, read the way invoicing reads it. */
const billed = async (flatId: any) => {
  const flat = await Flat.findById(flatId).lean();
  const q: any = (flat as any)?.quantities || {};
  const plain = q instanceof Map ? Object.fromEntries(q) : q;
  return { cars: Number(plain.parkingSlots || 0), bikes: Number(plain.twoWheelerSlots || 0) };
};

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    ResidentVehicle.deleteMany({ societyId }), SocietyOpsPolicy.deleteMany({ societyId }),
    ParkingZone.deleteMany({ societyId }), ParkingSlot.deleteMany({ societyId }),
    ParkingAllocation.deleteMany({ societyId }), ParkingRequest.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  // Built explicitly rather than left to autoIndex: assertion 1 races the
  // background index build otherwise, and an index that is not there yet
  // refuses nothing at all — which would make this script pass by accident.
  await Promise.all([
    ParkingZone.syncIndexes(), ParkingSlot.syncIndexes(),
    ParkingAllocation.syncIndexes(), ParkingRequest.syncIndexes(),
  ]);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('ParkAdmin', UserRole.SOCIETY_ADMIN);
    const owner101 = await mkUser('Owner101', UserRole.RESIDENT_OWNER);
    const owner102 = await mkUser('Owner102', UserRole.RESIDENT_OWNER);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };
    const actor = { userId: String(admin), userName: 'Setup' };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);

    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat101 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: owner101,
    });
    const flat102 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '102', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: owner102,
    });

    await Resident.create([
      { ...audit, flatId: flat101._id, userId: owner101, person: { name: 'Owner 101' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
      { ...audit, flatId: flat102._id, userId: owner102, person: { name: 'Owner 102' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
    ]);

    // Parking switched ON, and residents allowed to ask for a slot — which is
    // OFF by default, so it has to be said here.
    await SocietyOpsPolicy.create({
      ...audit, modules: ['PARKING'],
      residentFeatures: { parkingViewOwn: true, parkingRequest: true },
    } as any);

    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const tk101 = tokenFor(owner101, UserRole.RESIDENT_OWNER);
    const tk102 = tokenFor(owner102, UserRole.RESIDENT_OWNER);
    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });

    // ================================================ the bulk slot wizard
    console.log('The wizard — nobody hand-creates 200 slots');
    const zone = await parking.createZone(SID, {
      name: 'Basement 1', kind: 'BASEMENT', rows: 6, cols: 10,
    }, actor);
    ok('a parking area can be created', !!zone._id);

    const cars = await parking.bulkCreateSlots(SID, {
      zoneId: String(zone._id), prefix: 'B1-', count: 6, vehicleKind: 'CAR', perRow: 5,
    }, actor);
    ok('six car slots in one step', cars.created === 6, `created ${cars.created}`);
    ok('...numbered as a human reads them', cars.codes[0] === 'B1-1' && cars.codes[5] === 'B1-6',
      cars.codes.join(','));

    const bikes = await parking.bulkCreateSlots(SID, {
      zoneId: String(zone._id), prefix: 'BK-', count: 4, vehicleKind: 'BIKE', startRow: 4,
    }, actor);
    ok('and four two-wheeler slots', bikes.created === 4);

    let clashed = '';
    try {
      await parking.bulkCreateSlots(SID, {
        zoneId: String(zone._id), prefix: 'B1-', count: 3, startRow: 6,
      }, actor);
    } catch (e: any) { clashed = e.message; }
    ok('a second run over the same codes is refused, by code', clashed.includes('B1-1'), clashed);

    let overflowed = false;
    try {
      await parking.bulkCreateSlots(SID, {
        zoneId: String(zone._id), prefix: 'X-', count: 200, startRow: 1,
      }, actor);
    } catch { overflowed = true; }
    ok('...and so is a run that does not fit the floor plan', overflowed);

    const slotOf = async (code: string) =>
      (await ParkingSlot.findOne({ societyId, code }).lean())!;
    const b1 = await slotOf('B1-1');
    const b2 = await slotOf('B1-2');
    const b3 = await slotOf('B1-3');
    const b4 = await slotOf('B1-4');
    const bk1 = await slotOf('BK-1');

    // ============================== the bill is derived, not typed  (allocate)
    console.log('\nThe bill follows the slot — on allocate');
    // A hand-typed number, exactly as every society has today. It is about to
    // be overwritten, which is the feature.
    await Flat.updateOne({ _id: flat101._id }, { $set: { 'quantities.parkingSlots': 9 } });

    const a1 = await parking.allocate(SID, { slotId: String(b1._id), flatId: String(flat101._id) }, actor);
    ok('a slot can be allotted', a1.status === 'ACTIVE');
    ok('...and the slot says so on the map', (await ParkingSlot.findById(b1._id))?.status === 'ALLOCATED');
    ok('...and the hand-typed count is replaced by the truth', (await billed(flat101._id)).cars === 1,
      JSON.stringify(await billed(flat101._id)));

    await parking.allocate(SID, { slotId: String(b2._id), flatId: String(flat101._id) }, actor);
    await parking.allocate(SID, { slotId: String(bk1._id), flatId: String(flat101._id) }, actor);
    const afterAllocate = await billed(flat101._id);
    ok('two cars are counted as two car slots', afterAllocate.cars === 2, JSON.stringify(afterAllocate));
    ok('...and the bike lands on its own line, not the car one', afterAllocate.bikes === 1,
      JSON.stringify(afterAllocate));

    // A slot the society gives away free still shows on the map and still must
    // not reach the bill. Per-allocation, because "one free, second chargeable"
    // is what committees actually do.
    await parking.allocate(SID, {
      slotId: String(b3._id), flatId: String(flat101._id), chargeable: false,
    }, actor);
    ok('a slot marked not-chargeable is not billed', (await billed(flat101._id)).cars === 2,
      JSON.stringify(await billed(flat101._id)));

    // ========================= one live allocation per slot, by the DATABASE
    console.log('\nThe index, not the service, is what refuses the second one');
    let code = 0;
    try {
      // Deliberately bypasses the service. A check written in application code
      // passes a service-level test and still loses the race between two
      // committee members allotting the same slot from two browsers.
      await ParkingAllocation.create({
        societyId, slotId: b1._id, slotCode: b1.code, zoneId: b1.zoneId, slotKind: 'CAR',
        flatId: flat102._id, flatLabel: 'A Wing 102', kind: 'PERMANENT',
        startDate: new Date(), status: 'ACTIVE', chargeable: true,
        allocatedBy: admin, allocatedByName: 'Setup',
        createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
      } as any);
    } catch (e: any) { code = e?.code || e?.errorResponse?.code; }
    ok('the partial unique index refuses a second ACTIVE allocation', code === 11000, `error code ${code}`);
    ok('...and only one is live', await ParkingAllocation.countDocuments({ slotId: b1._id, status: 'ACTIVE' }) === 1);

    let refusal = '';
    try {
      await parking.allocate(SID, { slotId: String(b1._id), flatId: String(flat102._id) }, actor);
    } catch (e: any) { refusal = e.message; }
    ok('...and the service turns that into a sentence', refusal.includes('already allotted'), refusal);

    // ================================ the bill is derived, not typed (release)
    console.log('\nThe bill follows the slot — on release');
    const released = await parking.release(SID, String((await ParkingAllocation.findOne({ slotId: b2._id, status: 'ACTIVE' }))!._id), 'Sold the car', actor);
    ok('releasing ends the row rather than deleting it', released.allocation.status === 'ENDED');
    ok('...the history survives', await ParkingAllocation.countDocuments({ slotId: b2._id }) === 1);
    ok('...the slot goes back on the map as free',
      (await ParkingSlot.findById(b2._id))?.status === 'AVAILABLE');
    ok('...and the bill drops in the same breath', (await billed(flat101._id)).cars === 1,
      JSON.stringify(await billed(flat101._id)));

    // ============================================ the reconciliation report
    console.log('\nWhere the bill and the map disagree');
    const clean = await parking.reconcile(SID);
    ok('a flat whose count was derived shows no mismatch',
      !clean.mismatches.some(m => m.flatId === String(flat101._id)),
      JSON.stringify(clean.mismatches));

    // Somebody edits the flat by hand — the spreadsheet habit the report exists
    // to catch.
    await Flat.updateOne({ _id: flat101._id }, { $set: { 'quantities.parkingSlots': 4 } });
    const drifted = await parking.reconcile(SID);
    const row = drifted.mismatches.find(m => m.flatId === String(flat101._id));
    ok('a hand-typed count is flagged', !!row);
    ok('...with both numbers, so somebody can act on it',
      row?.billedCars === 4 && row?.allocatedCars === 1, JSON.stringify(row));

    // ============================================ a resident sees free/taken
    console.log('\nThe map does not hand every resident a directory of cars');
    await ResidentVehicle.create({
      ...audit, flatId: flat101._id, flatLabel: 'A Wing 101', blockId: wing._id,
      number: 'MH12ZZ1111', displayNumber: 'MH12ZZ1111', kind: 'CAR',
      slotId: b1._id, parkingSlot: 'B1-1', isActive: true,
    } as any);

    const nosy = await request(app).get(`/api/v1/parking/map/${zone._id}`).set(auth(tk102));
    ok('a resident may open the map', nosy.status === 200, `got ${nosy.status}`);
    const nosySlot = nosy.body?.data?.slots?.find((s: any) => s.code === 'B1-1');
    ok('...and sees that B1-1 is taken', nosySlot?.status === 'ALLOCATED');
    ok('...but NOT which flat holds it', !nosySlot?.holder, JSON.stringify(nosySlot));
    ok('...nor the plate, anywhere in the payload',
      !JSON.stringify(nosy.body).includes('MH12ZZ1111'));
    ok('...nor the neighbour\'s name', !JSON.stringify(nosy.body).includes('Owner 101'));
    ok('...and is told plainly that it is not showing holders',
      nosy.body?.data?.canSeeHolders === false);

    const own = await request(app).get(`/api/v1/parking/map/${zone._id}`).set(auth(tk101));
    const ownSlot = own.body?.data?.slots?.find((s: any) => s.code === 'B1-1');
    ok('the flat that holds it sees its own slot in full', ownSlot?.isMine === true && !!ownSlot?.holder,
      JSON.stringify(ownSlot));

    const office = await request(app).get(`/api/v1/parking/map/${zone._id}`).set(auth(adminTk));
    const officeSlot = office.body?.data?.slots?.find((s: any) => s.code === 'B1-1');
    ok('the office sees who holds it', officeSlot?.holder?.flatLabel === 'A Wing 101',
      JSON.stringify(officeSlot?.holder));
    ok('...including the plate, which is what the popover is for',
      officeSlot?.holder?.plate === 'MH12ZZ1111');

    // ======================================================== the transfer
    console.log('\nA transfer moves the bill as well as the slot');
    const live1 = await ParkingAllocation.findOne({ slotId: b1._id, status: 'ACTIVE' });
    const moved = await parking.transfer(SID, String(live1!._id), {
      toFlatId: String(flat102._id), reason: 'Flat sold',
    }, actor);
    ok('the slot now belongs to the other flat', String(moved.flatId) === String(flat102._id));
    ok('...the old holding is history, not an edit',
      await ParkingAllocation.countDocuments({ slotId: b1._id }) === 2);
    ok('...the flat that received it is billed', (await billed(flat102._id)).cars === 1,
      JSON.stringify(await billed(flat102._id)));
    ok('...and the flat that gave it up is not, hand-typed number and all',
      (await billed(flat101._id)).cars === 0, JSON.stringify(await billed(flat101._id)));

    // ==================================================== the waiting list
    console.log('\nThe waiting list is ordered, and it is yours only');
    const forged = await request(app).post('/api/v1/parking/requests')
      .set(auth(tk102)).send({ flatId: String(flat101._id), vehicleKind: 'CAR' });
    ok('a resident cannot queue on another flat\'s behalf', forged.status === 403, `got ${forged.status}`);

    const asked = await request(app).post('/api/v1/parking/requests')
      .set(auth(tk102)).send({ vehicleKind: 'CAR', note: 'Second car' });
    ok('...but can for their own', asked.status === 201, `got ${asked.status}`);
    ok('...and the flat is filled in without being asked',
      String(asked.body?.data?.flatId) === String(flat102._id));

    const again = await request(app).post('/api/v1/parking/requests')
      .set(auth(tk102)).send({ vehicleKind: 'CAR' });
    ok('asking twice does not buy a better place in the queue', again.status === 409, `got ${again.status}`);

    const decided = await request(app).post(`/api/v1/parking/requests/${asked.body?.data?._id}/decide`)
      .set(auth(adminTk)).send({ decision: 'APPROVE', slotId: String(b4._id) });
    ok('the committee can approve it into a slot', decided.status === 200, `got ${decided.status}`);
    ok('...and the slot is genuinely allotted, not just marked approved',
      await ParkingAllocation.countDocuments({ slotId: b4._id, status: 'ACTIVE' }) === 1);
    ok('...so the bill moved with it', (await billed(flat102._id)).cars === 2,
      JSON.stringify(await billed(flat102._id)));

    // ============================================= what flat-lifecycle calls
    console.log('\nreleaseAllocationsForFlat — the hook flat-lifecycle should call');
    const swept = await parking.releaseAllocationsForFlat(SID, String(flat101._id), 'Flat sold', actor);
    ok('every live allocation on the flat ends', swept.released === 2, `released ${swept.released}`);
    ok('...nothing is left live', await ParkingAllocation.countDocuments({ flatId: flat101._id, status: 'ACTIVE' }) === 0);
    ok('...and it bills for nothing',
      swept.billed.cars === 0 && swept.billed.bikes === 0, JSON.stringify(swept.billed));
    ok('...while the history stays whole',
      await ParkingAllocation.countDocuments({ flatId: flat101._id }) === 4);

    /**
     * ...and that flat-lifecycle now actually calls it.
     *
     * The hook existing and the hook being wired are different facts, and the
     * second one is what a resident feels: a sale that left the bay allotted
     * would keep billing the departed owner for parking the buyer is using,
     * because `Flat.quantities.parkingSlots` is derived from live allocations.
     *
     * Driven through a session, because that is the part that could break —
     * `releaseAllocationsForFlat` used to open its own transaction, which
     * cannot nest inside the one the sale already holds.
     */
    // Whichever bay is genuinely free at this point — naming one by hand ties
    // this check to every allocation the script happens to make above it.
    const freeSlot = await ParkingSlot.findOne({
      societyId, status: 'AVAILABLE', vehicleKind: { $in: ['CAR', 'ANY'] }, isActive: true,
    }).lean();
    const resold = await parking.allocate(SID, {
      slotId: String(freeSlot!._id), flatId: String(flat102._id), kind: 'PERMANENT',
    }, actor);
    ok('a bay is allotted before the sale', resold.status === 'ACTIVE');

    const saleSession = await mongoose.startSession();
    try {
      await saleSession.withTransaction(async () => {
        await parking.releaseAllocationsForFlat(
          SID, String(flat102._id), 'Flat sold', actor, { session: saleSession },
        );
      });
    } finally {
      await saleSession.endSession();
    }
    ok('releasing inside somebody else\'s transaction works',
      await ParkingAllocation.countDocuments({ flatId: flat102._id, status: 'ACTIVE' }) === 0);
    const afterSale = await Flat.findById(flat102._id).lean();
    ok('...and the billing count goes with it',
      (afterSale?.quantities?.parkingSlots ?? 0) === 0,
      JSON.stringify(afterSale?.quantities));

    // ============================================ a society that says no
    console.log('\nA society that does not manage parking has no parking');
    await SocietyOpsPolicy.updateOne({ societyId }, { $set: { modules: ['GATE'] } });
    const gone = await request(app).get('/api/v1/parking/zones').set(auth(adminTk));
    ok('every route returns 404, not a 403 about a feature nobody bought',
      gone.status === 404, `got ${gone.status}`);
    const goneMap = await request(app).get(`/api/v1/parking/map/${zone._id}`).set(auth(tk101));
    ok('...including the resident-facing map', goneMap.status === 404, `got ${goneMap.status}`);
    ok('...and the slots are still there when it comes back on',
      await ParkingSlot.countDocuments({ societyId, isActive: true }) === 10);

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
