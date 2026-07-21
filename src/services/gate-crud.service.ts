import mongoose from 'mongoose';
import { Gate, IGate, GATE_KINDS } from '../models/gate.model';
import { Block } from '../models/block.model';
import { VisitorEntry } from '../models/visitor-entry.model';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class GateError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

export interface GateInput {
  code: string;
  name: string;
  kind?: string;
  handlesEntry?: boolean;
  handlesExit?: boolean;
  blockId?: string;
  isActive?: boolean;
  notes?: string;
}

export async function listGates(societyId: string, includeInactive = false) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (!includeInactive) filter.isActive = true;
  return Gate.find(filter).sort({ isActive: -1, code: 1 }).lean();
}

/**
 * The gate the console uses when the guard has not picked one.
 *
 * A society with a single gate should never have to choose it every time —
 * that is friction with no decision behind it. When exactly one active gate
 * exists it IS the default; with several, the guard picks.
 */
export async function defaultGate(societyId: string): Promise<IGate | null> {
  const active = await Gate.find({ societyId: oid(societyId), isActive: true }).limit(2).lean();
  return active.length === 1 ? (active[0] as any) : null;
}

async function resolveGate(societyId: string, input: GateInput) {
  if (!input.code?.trim()) throw new GateError('A gate needs a short code, like "Gate 2".');
  if (!input.name?.trim()) throw new GateError('A gate needs a name.');
  if (input.kind && !GATE_KINDS.includes(input.kind as any)) throw new GateError('That is not a kind of gate.');
  if (input.handlesEntry === false && input.handlesExit === false) {
    throw new GateError('A gate that handles neither entry nor exit does nothing — turn one on.');
  }

  let blockName: string | undefined;
  let blockId: mongoose.Types.ObjectId | undefined;
  if (input.blockId) {
    const block = await Block.findOne({ _id: input.blockId, societyId: oid(societyId) }).select('name').lean();
    if (!block) throw new GateError('That wing does not belong to this society.');
    blockName = block.name; blockId = block._id as any;
  }
  return { blockId, blockName };
}

export async function createGate(societyId: string, input: GateInput, actor: Actor): Promise<IGate> {
  const { blockId, blockName } = await resolveGate(societyId, input);
  try {
    return await Gate.create({
      societyId: oid(societyId),
      code: input.code.trim(), name: input.name.trim(),
      kind: input.kind || 'MAIN',
      handlesEntry: input.handlesEntry !== false,
      handlesExit: input.handlesExit !== false,
      blockId, blockName,
      isActive: true, notes: input.notes,
      createdBy: oid(actor.userId), createdByName: actor.userName,
      updatedBy: oid(actor.userId), updatedByName: actor.userName,
    });
  } catch (e: any) {
    if (e?.code === 11000) throw new GateError('A gate with that code already exists.');
    throw e;
  }
}

export async function updateGate(societyId: string, id: string, input: GateInput, actor: Actor): Promise<IGate> {
  const gate = await Gate.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!gate) throw new GateError('That gate could not be found.', 404);
  const { blockId, blockName } = await resolveGate(societyId, { ...input, code: input.code ?? gate.code, name: input.name ?? gate.name });

  if (input.code !== undefined) gate.code = input.code.trim();
  if (input.name !== undefined) gate.name = input.name.trim();
  if (input.kind !== undefined) gate.kind = input.kind as any;
  if (input.handlesEntry !== undefined) gate.handlesEntry = input.handlesEntry;
  if (input.handlesExit !== undefined) gate.handlesExit = input.handlesExit;
  if (input.blockId !== undefined) { gate.blockId = blockId; gate.blockName = blockName; }
  if (input.isActive !== undefined) gate.isActive = input.isActive;
  if (input.notes !== undefined) gate.notes = input.notes;
  gate.updatedBy = oid(actor.userId); gate.updatedByName = actor.userName;
  try {
    await gate.save();
  } catch (e: any) {
    if (e?.code === 11000) throw new GateError('A gate with that code already exists.');
    throw e;
  }
  return gate;
}

/**
 * Retire a gate. Deactivated, never deleted — months of entries name it, and a
 * deleted gate would leave those reading "unknown gate".
 */
export async function retireGate(societyId: string, id: string, actor: Actor): Promise<boolean> {
  const stillOpen = await VisitorEntry.countDocuments({
    societyId: oid(societyId), entryGateId: oid(id), status: { $in: ['INSIDE', 'AWAITING', 'AT_GATE'] },
  });
  if (stillOpen > 0) {
    throw new GateError(`${stillOpen} visitor(s) are still recorded at this gate — close them off first.`);
  }
  const res = await Gate.updateOne(
    { _id: oid(id), societyId: oid(societyId) },
    { $set: { isActive: false, updatedBy: oid(actor.userId), updatedByName: actor.userName } },
  );
  return res.modifiedCount > 0;
}

/** Validate a gate id belongs to the society and can do what is being asked. */
export async function assertGateFor(
  societyId: string, gateId: string | undefined, direction: 'entry' | 'exit',
): Promise<{ id: mongoose.Types.ObjectId; name: string } | undefined> {
  if (!gateId) return undefined;
  const gate = await Gate.findOne({ _id: oid(gateId), societyId: oid(societyId), isActive: true }).select('name handlesEntry handlesExit').lean();
  if (!gate) throw new GateError('That gate is unknown to this society.');
  if (direction === 'entry' && !gate.handlesEntry) throw new GateError(`${gate.name} does not take entries.`);
  if (direction === 'exit' && !gate.handlesExit) throw new GateError(`${gate.name} does not record exits.`);
  return { id: gate._id as any, name: gate.name };
}
