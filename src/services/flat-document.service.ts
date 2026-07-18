import mongoose from 'mongoose';
import { Flat, IFlatDocument } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { UserRole } from '../constants/roles';
import s3Service from './s3.service';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class FlatDocumentError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface Actor { userId: string; userName: string; role?: string }

/**
 * What this caller may do with one flat's papers.
 *
 * These are title deeds. A sale deed carries the purchase price, the seller's
 * details and sometimes the loan — the owner's private business, not the
 * tenant's. So "lives in the flat" is the wrong test; "belongs to the OWNER
 * household of this flat" is the right one, and it correctly excludes a tenant's
 * own family members too.
 */
export interface FlatDocAccess {
  canView: boolean;
  canUpload: boolean;
  /** May remove a document they uploaded themselves. */
  canDeleteOwn: boolean;
  /** May remove anything, including what the society filed. */
  canDeleteAny: boolean;
}

const NO_ACCESS: FlatDocAccess = { canView: false, canUpload: false, canDeleteOwn: false, canDeleteAny: false };

export async function flatDocumentAccess(societyId: string, flatId: string, actor: Actor): Promise<FlatDocAccess> {
  if (actor.role === UserRole.SOCIETY_ADMIN) {
    return { canView: true, canUpload: true, canDeleteOwn: true, canDeleteAny: true };
  }
  if (actor.role === UserRole.SOCIETY_COMMITTEE) {
    // The committee files papers but does not remove them — taking a deed off the
    // society's record is a decision that should sit with one accountable person.
    return { canView: true, canUpload: true, canDeleteOwn: false, canDeleteAny: false };
  }

  // A resident: only ever their own flat, and only if they are on the OWNER side
  // of it. `householdType` is the real signal — the role alone would let a
  // tenant's family member through.
  const resident = await Resident.findOne({
    flatId: oid(flatId), userId: oid(actor.userId), isActive: true,
  }).select('householdType isOwner').lean();

  if (resident?.householdType !== 'OWNER') return NO_ACCESS;

  // The owner's household may read the papers. Adding to them is the owner's own
  // act, though: a title document filed against the flat should carry the name of
  // the person who actually holds the title, not whichever relative had the scan
  // handy. They may undo their own upload, but never remove what the society
  // filed — otherwise an inconvenient paper could quietly disappear.
  const isTheOwner = resident.isOwner === true || actor.role === UserRole.RESIDENT_OWNER;
  return { canView: true, canUpload: isTheOwner, canDeleteOwn: isTheOwner, canDeleteAny: false };
}

/** What a screen sees. The S3 key never leaves the server — a raw key is a
 *  standing invitation to try fetching it directly. */
export interface FlatDocumentView {
  _id: string;
  kind: string;
  label: string;
  uploadedAt: Date;
  uploadedByName: string;
  /** Whether THIS caller may remove it — so the UI shows a bin only where one works. */
  canRemove?: boolean;
}

const toView = (d: IFlatDocument): FlatDocumentView => ({
  _id: String(d._id),
  kind: d.kind,
  label: d.label,
  uploadedAt: d.uploadedAt,
  uploadedByName: d.uploadedByName,
});

/**
 * Load a flat, scoped to its society.
 *
 * Every entry point goes through this, so a flat id belonging to another
 * society is a 404 rather than a document leak — the id alone is never enough.
 */
async function ownedFlat(societyId: string, flatId: string) {
  const flat = await Flat.findOne({ _id: flatId, societyId: oid(societyId) });
  if (!flat) throw new FlatDocumentError('Flat not found', 404);
  return flat;
}

export async function listFlatDocuments(societyId: string, flatId: string, actor: Actor): Promise<FlatDocumentView[]> {
  const flat = await ownedFlat(societyId, flatId);
  const access = await flatDocumentAccess(societyId, flatId, actor);
  if (!access.canView) throw new FlatDocumentError('These documents are not shared with you', 403);
  return (flat.documents || [])
    .slice()
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map(d => ({ ...toView(d), canRemove: access.canDeleteAny || (access.canDeleteOwn && String(d.uploadedBy) === String(actor.userId)) }));
}

/**
 * Attach an already-uploaded object to a flat.
 *
 * The bytes reach S3 through the shared `POST /upload/document` route, which
 * hands back `{ url, key }`; this only records the reference. Keeping upload and
 * attach separate means a half-finished form never leaves an orphaned row
 * pointing at a file that was never stored.
 */
export async function addFlatDocument(
  societyId: string,
  flatId: string,
  input: { kind?: string; label: string; key: string; url: string },
  actor: Actor,
): Promise<FlatDocumentView> {
  const flat = await ownedFlat(societyId, flatId);
  const access = await flatDocumentAccess(societyId, flatId, actor);
  if (!access.canUpload) throw new FlatDocumentError('You cannot add documents to this flat', 403);

  // The key must be one our own upload route minted. Without this, a caller
  // could attach any object in the bucket — including another society's — and
  // then read it back through the presigned-download endpoint.
  if (!input.key || !input.key.startsWith('flat-documents/')) {
    throw new FlatDocumentError('That file was not uploaded through the document uploader');
  }
  if (!input.label?.trim()) throw new FlatDocumentError('Give the document a name');

  const doc = {
    kind: (input.kind as any) || 'OTHER',
    label: input.label.trim(),
    key: input.key,
    url: input.url,
    uploadedAt: new Date(),
    uploadedBy: oid(actor.userId),
    uploadedByName: actor.userName,
  };
  flat.documents.push(doc as any);
  flat.updatedBy = oid(actor.userId);
  flat.updatedByName = actor.userName;
  await flat.save();

  return toView(flat.documents[flat.documents.length - 1]);
}

/** A short-lived signed URL. Nothing in the bucket is publicly readable. */
export async function flatDocumentDownloadUrl(societyId: string, flatId: string, docId: string, actor: Actor): Promise<string> {
  const flat = await ownedFlat(societyId, flatId);
  const access = await flatDocumentAccess(societyId, flatId, actor);
  if (!access.canView) throw new FlatDocumentError('These documents are not shared with you', 403);
  const doc = (flat.documents || []).find(d => String(d._id) === String(docId));
  if (!doc) throw new FlatDocumentError('Document not found', 404);
  return s3Service.getSignedDownloadUrl(doc.key, { expiresIn: 5 * 60, downloadName: doc.label });
}

/**
 * Detach a document.
 *
 * The S3 object is deliberately left in place. A title deed removed by a
 * mistaken click is not recoverable if the bytes are gone too, and storage is
 * far cheaper than a member's sale deed. The reference disappears from the flat,
 * which is what "delete" means to the person clicking it.
 */
export async function removeFlatDocument(
  societyId: string,
  flatId: string,
  docId: string,
  actor: Actor,
): Promise<{ label: string }> {
  const flat = await ownedFlat(societyId, flatId);
  const access = await flatDocumentAccess(societyId, flatId, actor);
  const doc = (flat.documents || []).find(d => String(d._id) === String(docId));
  if (!doc) throw new FlatDocumentError('Document not found', 404);

  const mine = String(doc.uploadedBy) === String(actor.userId);
  if (!access.canDeleteAny && !(access.canDeleteOwn && mine)) {
    throw new FlatDocumentError(
      access.canDeleteOwn
        ? 'You can only remove documents you uploaded yourself. Ask the committee to remove this one.'
        : 'You cannot remove documents from this flat',
      403,
    );
  }

  flat.documents = flat.documents.filter(d => String(d._id) !== String(docId)) as any;
  flat.updatedBy = oid(actor.userId);
  flat.updatedByName = actor.userName;
  await flat.save();

  return { label: doc.label };
}
