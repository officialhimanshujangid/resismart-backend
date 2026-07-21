import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as parking from '../services/parking.service';
import { ParkingError } from '../services/parking.service';
import { Resident } from '../models/resident.model';
import { allows } from '../services/access-role.service';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

/**
 * The office allotting on somebody's behalf, versus a resident asking for
 * themselves. False when `req.access` is absent, which is the safe answer.
 */
const onBehalf = (req: Request) => !!req.access && allows(req.access, 'PARKING_MANAGE', 'FULL');

/**
 * May this caller see WHO holds a slot?
 *
 * The map's popover carries a flat number, a resident's name and a number
 * plate. Handed to every resident that is a directory of who owns which car,
 * assembled from a screen whose stated purpose is "is B1-14 free?". Anybody
 * without PARKING_VIEW gets colours, plus their own flat's slot in full.
 */
const canSeeHolders = (req: Request) => !!req.access && allows(req.access, 'PARKING_VIEW', 'READ');

/** The flats this person actually lives in. Never taken from the request. */
async function ownFlatIds(req: Request): Promise<string[]> {
  const homes = await Resident.find(
    { societyId: oid(req.user!.activeTenantId), userId: oid(req.user!.userId), isActive: true },
    { flatId: 1 },
  ).lean();
  return homes.map(h => String(h.flatId));
}

/** A wing-scoped role sees its own wings. Undefined means no narrowing. */
const wingScope = (req: Request): string[] | undefined =>
  req.access && !req.access.isAdmin && req.access.scope && !req.access.scope.allBlocks
    ? req.access.scope.blockIds
    : undefined;

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof ParkingError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

// ----------------------------------------------------------------- settings

/**
 * The wizard, both halves.
 *
 * These two are the only routes in the module that stay reachable when parking
 * is switched OFF — see the note in `parking.routes.ts`. A settings screen that
 * 404s is a society that can never switch the feature on.
 */
export const settings = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await parking.getParkingSettings(String(req.user!.activeTenantId)) });
  } catch (e: any) { fail(res, e, 'load your parking settings'); }
};

export const configure = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const out = await parking.configureParking(societyId, req.body, actorOf(req));

    // Audited as a finance change, not merely an ops one: this call is what
    // starts or stops a line on every flat's bill, and the money question
    // afterwards is always "who set that rate, and when".
    auditFinance(req, 'PARKING_SETTINGS_UPDATED', 'SocietyOpsPolicy', societyId, {
      newValues: {
        managed: out.managed, chargeable: out.chargeable,
        billingFrequency: out.billingFrequency, annualBillingMonth: out.annualBillingMonth,
        perSlotPaise: out.perSlotPaise, twoWheelerPaise: out.twoWheelerPaise,
        chargeHeadId: out.carHead?._id, twoWheelerChargeHeadId: out.bikeHead?._id,
      },
    });

    // Said in the wizard's own words, because "billingFrequency: YEARLY" tells
    // the person who just set it nothing about what their residents will see.
    const message = !out.managed
      ? 'Parking is switched off. Your slots and allocations are kept, and any parking charge stops from the next bill.'
      : !out.chargeable
        ? 'Parking is on and free for residents. Nothing is added to anybody\'s bill.'
        : out.billingFrequency === 'YEARLY'
          ? `Saved. Each slot is charged once a year, in ${MONTHS[out.annualBillingMonth - 1]}.`
          : 'Saved. Each slot is charged every month, with the maintenance bill.';

    res.json({ success: true, data: out, message });
  } catch (e: any) { fail(res, e, 'save your parking settings'); }
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// -------------------------------------------------------------------- zones

export const listZones = async (req: Request, res: Response) => {
  try {
    const rows = await parking.listZones(String(req.user!.activeTenantId), req.query.all === 'true');
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load the parking areas'); }
};

export const createZone = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const zone = await parking.createZone(societyId, req.body, actorOf(req));
    auditFinance(req, 'PARKING_ZONE_CREATED', 'ParkingZone', String(zone._id), {
      newValues: { name: zone.name, kind: zone.kind },
    });
    res.status(201).json({ success: true, data: zone, message: `${zone.name} added.` });
  } catch (e: any) { fail(res, e, 'add that parking area'); }
};

export const updateZone = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const zone = await parking.updateZone(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'PARKING_ZONE_UPDATED', 'ParkingZone', String(zone._id));
    res.json({ success: true, data: zone, message: 'Saved.' });
  } catch (e: any) { fail(res, e, 'save that parking area'); }
};

// -------------------------------------------------------------------- slots

export const listSlots = async (req: Request, res: Response) => {
  try {
    const rows = await parking.listSlots(String(req.user!.activeTenantId), {
      zoneId: req.query.zoneId ? String(req.query.zoneId) : undefined,
      status: req.query.status ? String(req.query.status) as any : undefined,
      includeRetired: req.query.all === 'true',
    });
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load the slots'); }
};

export const bulkCreateSlots = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const out = await parking.bulkCreateSlots(societyId, req.body, actorOf(req));
    auditFinance(req, 'PARKING_SLOTS_CREATED', 'ParkingSlot', String(req.body.zoneId), {
      newValues: { created: out.created, from: out.codes[0], to: out.codes[out.codes.length - 1] },
    });
    res.status(201).json({
      success: true, data: out,
      message: `${out.created} slots created, ${out.codes[0]} to ${out.codes[out.codes.length - 1]}.`,
    });
  } catch (e: any) { fail(res, e, 'create those slots'); }
};

export const updateSlot = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const slot = await parking.updateSlot(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'PARKING_SLOT_UPDATED', 'ParkingSlot', String(slot._id), {
      newValues: { code: slot.code, status: slot.status },
    });
    res.json({ success: true, data: slot, message: 'Saved.' });
  } catch (e: any) { fail(res, e, 'save that slot'); }
};

// ---------------------------------------------------------------------- map

export const map = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const detailed = canSeeHolders(req);
    // Resolved even for the detailed view, so a committee member's own slot is
    // still flagged as theirs on the map they are looking at.
    const mine = await ownFlatIds(req);
    const data = await parking.listMap(societyId, req.params.zoneId, { detailed, ownFlatIds: mine });
    res.json({ success: true, data: { ...data, canSeeHolders: detailed } });
  } catch (e: any) { fail(res, e, 'load the map'); }
};

// -------------------------------------------------------------- allocations

export const listAllocations = async (req: Request, res: Response) => {
  try {
    const rows = await parking.listAllocations(String(req.user!.activeTenantId), {
      flatId: req.query.flatId ? String(req.query.flatId) : undefined,
      zoneId: req.query.zoneId ? String(req.query.zoneId) : undefined,
      status: req.query.status ? String(req.query.status) as any : undefined,
      blockIds: wingScope(req),
    });
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load the allocations'); }
};

export const allocate = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await parking.allocate(societyId, req.body, actorOf(req));
    auditFinance(req, 'PARKING_ALLOCATED', 'ParkingAllocation', String(row._id), {
      newValues: { slot: row.slotCode, flat: row.flatLabel, chargeable: row.chargeable },
    });
    res.status(201).json({
      success: true, data: row,
      // Said out loud, because the whole point of the module is that the bill
      // now follows the slot — and a committee that does not know that will
      // keep editing the flat's count by hand.
      message: row.chargeable
        ? `${row.slotCode} allotted to ${row.flatLabel}. Their bill now counts it.`
        : `${row.slotCode} allotted to ${row.flatLabel}. Not charged.`,
    });
  } catch (e: any) { fail(res, e, 'allot that slot'); }
};

export const release = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const out = await parking.release(societyId, req.params.id, req.body?.reason, actorOf(req));
    auditFinance(req, 'PARKING_RELEASED', 'ParkingAllocation', req.params.id, {
      newValues: { slot: out.allocation.slotCode, flat: out.allocation.flatLabel, billed: out.billed },
    });
    res.json({
      success: true, data: out,
      message: `${out.allocation.slotCode} is free. ${out.allocation.flatLabel} is now billed for ${out.billed.cars} car slot(s) and ${out.billed.bikes} two-wheeler slot(s).`,
    });
  } catch (e: any) { fail(res, e, 'release that slot'); }
};

export const transfer = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await parking.transfer(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'PARKING_TRANSFERRED', 'ParkingAllocation', String(row._id), {
      newValues: { slot: row.slotCode, flat: row.flatLabel },
    });
    res.json({ success: true, data: row, message: `${row.slotCode} now belongs to ${row.flatLabel}.` });
  } catch (e: any) { fail(res, e, 'transfer that slot'); }
};

/** A resident's own slots. The whole of what `parkingViewOwn` offers. */
export const mine = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    res.json({ success: true, data: await parking.myAllocations(societyId, String(req.user!.userId)) });
  } catch (e: any) { fail(res, e, 'load your parking'); }
};

// ----------------------------------------------------------------- requests

export const listRequests = async (req: Request, res: Response) => {
  try {
    const rows = await parking.listRequests(String(req.user!.activeTenantId), {
      status: req.query.status ? String(req.query.status) : undefined,
      flatId: req.query.flatId ? String(req.query.flatId) : undefined,
      blockIds: wingScope(req),
    });
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load the waiting list'); }
};

export const raiseRequest = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const office = onBehalf(req);

    // Filled in from the caller's own home when they did not name one. A
    // resident should not have to know their flat's id, and the service refuses
    // a flat that is not theirs regardless of what arrives here.
    let flatId = req.body.flatId as string | undefined;
    if (!flatId) {
      const [own] = await ownFlatIds(req);
      if (!own) return res.status(400).json({ success: false, message: 'Which flat is this for?' });
      flatId = own;
    }

    const row = await parking.raiseRequest(
      societyId, { ...req.body, flatId }, actorOf(req), { onBehalf: office },
    );
    res.status(201).json({
      success: true, data: row,
      message: 'You are on the waiting list. The committee will come back to you.',
    });
  } catch (e: any) { fail(res, e, 'add you to the waiting list'); }
};

export const decideRequest = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await parking.decideRequest(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'PARKING_REQUEST_DECIDED', 'ParkingRequest', String(row._id), {
      newValues: { status: row.status, flat: row.flatLabel },
    });
    res.json({
      success: true, data: row,
      message: row.status === 'APPROVED' ? 'Allotted.' : 'Turned down, and they have been told why.',
    });
  } catch (e: any) { fail(res, e, 'record that decision'); }
};

export const withdrawRequest = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await parking.withdrawRequest(societyId, req.params.id, actorOf(req), {
      onBehalf: onBehalf(req),
    });
    res.json({ success: true, data: row, message: 'Taken off the waiting list.' });
  } catch (e: any) { fail(res, e, 'withdraw that request'); }
};

// ------------------------------------------------------------------ reports

export const occupancy = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await parking.occupancyReport(String(req.user!.activeTenantId)) });
  } catch (e: any) { fail(res, e, 'build that report'); }
};

/**
 * Where the bill and the map disagree. On day one this finds real money.
 */
export const reconciliation = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await parking.reconcile(String(req.user!.activeTenantId)) });
  } catch (e: any) { fail(res, e, 'check the parking billing'); }
};
