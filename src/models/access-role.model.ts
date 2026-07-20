import mongoose, { Schema, Document } from 'mongoose';

/**
 * A named bundle of permissions inside ONE society.
 *
 * Deliberately not the existing `PermissionRole`, which serves ResiSmart's own
 * platform employees. That collection has no `societyId` and its `name` is
 * globally unique, so reusing it would mean one society could be handed
 * another's role, and the second society to create a "Manager" would be told
 * the name is taken — by a society it cannot see and for a reason nobody could
 * work out. Two different populations, two different collections.
 *
 * Same shape though: the read/create/edit/delete quad is what the existing
 * permission editor already teaches, and there is no reason to make an admin
 * learn a second idea.
 */

/** What a role may do with one module. */
export type PermissionLevel = 'NONE' | 'READ' | 'FULL';

/**
 * The modules a society-level role can be given.
 *
 * NOT the same list as `financeModule` (which decides whether a society uses a
 * feature at all) or `moduleKey` (which filters ResiSmart's own staff). A
 * society can have the expenses module switched on and still not want the
 * gatekeeper to see it — three separate questions, three separate fields.
 */
export const ACCESS_MODULES = [
  'GATE_CONSOLE', 'GATE_LOGS',
  'COMPLAINTS_OWN', 'COMPLAINTS_MANAGE', 'COMPLAINTS_CONDUCT',
  'STAFF_VIEW', 'STAFF_MANAGE',
  'RESIDENTS_VIEW',
  'COMMITTEE_MANAGE',
  'ACCESS_MANAGE',
  'OPS_SETTINGS',
  'FINANCE_VIEW', 'FINANCE_MANAGE',
] as const;
export type AccessModule = typeof ACCESS_MODULES[number];

export interface IModuleGrant {
  module: AccessModule;
  level: PermissionLevel;
}

export interface IAccessRole extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  /** Whether this role is offered for committee seats, staff posts, or both. */
  appliesTo: 'COMMITTEE' | 'STAFF' | 'BOTH';
  permissions: IModuleGrant[];
  /**
   * Which wings this role can see.
   *
   * No competitor models this at all — their permissions are module-only. But
   * "Rajesh looks after A and B wing" is how large societies actually organise
   * themselves, and a committee member for one wing seeing every other wing's
   * complaints is the same privacy failure as a neighbour reading your visitor
   * log. Enforced in `requirePermission`, not just rendered.
   */
  scope: { allBlocks: boolean; blockIds: mongoose.Types.ObjectId[] };
  /** Seeded roles cannot be deleted, so a society always has something to assign. */
  isSystem: boolean;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ModuleGrantSchema = new Schema<IModuleGrant>({
  module: { type: String, required: true },
  // NONE is stored rather than implied by absence, so an admin who deliberately
  // took a module away is distinguishable from one who never considered it —
  // the same distinction `FinancePolicy.modules` exists to preserve.
  level: { type: String, enum: ['NONE', 'READ', 'FULL'], required: true, default: 'NONE' },
}, { _id: false });

const AccessRoleSchema = new Schema<IAccessRole>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  appliesTo: { type: String, enum: ['COMMITTEE', 'STAFF', 'BOTH'], default: 'BOTH' },
  permissions: { type: [ModuleGrantSchema], default: [] },
  scope: {
    allBlocks: { type: Boolean, default: true },
    blockIds: [{ type: Schema.Types.ObjectId, ref: 'Block' }],
  },
  isSystem: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// Scoped to the society, NOT global. Two societies may both have a "Manager".
AccessRoleSchema.index({ societyId: 1, name: 1 }, { unique: true });
AccessRoleSchema.index({ societyId: 1, isActive: 1 });

export const AccessRole = mongoose.model<IAccessRole>('AccessRole', AccessRoleSchema);
export default AccessRole;
