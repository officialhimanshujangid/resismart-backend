import { Request, Response } from 'express';
import * as docs from '../services/flat-document.service';
import { FlatDocumentError } from '../services/flat-document.service';
import { getActiveUnitId } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';
import { auditFinance } from '../utils/finance-audit.util';

const fail = (res: Response, e: any) => {
  if (e instanceof FlatDocumentError) { res.status(e.status).json({ error: e.message }); return; }
  res.status(400).json({ error: e.message });
};

const STAFF_ROLES: string[] = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE];

/**
 * Who is asking, about which flat.
 *
 * A resident's flat comes from their signed session, so the `:flatId` in the URL
 * is ignored for them entirely — there is no id to tamper with. Committee and
 * admin may name any flat, and the service still scopes every lookup by society.
 * Whether they may then see anything is `flatDocumentAccess`'s decision, not this
 * function's: a tenant reaches here fine and is refused there.
 */
const resolve = (req: Request) => {
  const role = String(req.user?.activeRole || '');
  const isStaff = STAFF_ROLES.includes(role);
  return {
    societyId: req.user?.activeTenantId,
    flatId: isStaff ? req.params.flatId : getActiveUnitId(req),
    actor: { userId: req.user!.userId, userName: req.user!.userName || 'Member', role },
  };
};

/** GET /societies/flats/:flatId/documents */
export const list = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId, actor } = resolve(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    if (!flatId) { res.status(403).json({ error: 'No flat selected' }); return; }
    res.json(await docs.listFlatDocuments(societyId, flatId, actor));
  } catch (e: any) { fail(res, e); }
};

/** POST /societies/flats/:flatId/documents — attach an already-uploaded file. */
export const add = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId, actor } = resolve(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    if (!flatId) { res.status(403).json({ error: 'No flat selected' }); return; }
    const doc = await docs.addFlatDocument(societyId, flatId, req.body, actor);
    auditFinance(req, 'FLAT_DOCUMENT_ADD', 'Flat', flatId, { newValues: { label: doc.label, kind: doc.kind } });
    res.json(doc);
  } catch (e: any) { fail(res, e); }
};

/** GET /societies/flats/:flatId/documents/:docId/download — short-lived signed URL. */
export const download = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId, actor } = resolve(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    if (!flatId) { res.status(403).json({ error: 'No flat selected' }); return; }
    const url = await docs.flatDocumentDownloadUrl(societyId, flatId, req.params.docId, actor);
    res.json({ url });
  } catch (e: any) { fail(res, e); }
};

/** DELETE /societies/flats/:flatId/documents/:docId */
export const remove = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId, actor } = resolve(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    if (!flatId) { res.status(403).json({ error: 'No flat selected' }); return; }
    const { label } = await docs.removeFlatDocument(societyId, flatId, req.params.docId, actor);
    auditFinance(req, 'FLAT_DOCUMENT_REMOVE', 'Flat', flatId, { oldValues: { label } });
    res.json({ message: `${label} removed` });
  } catch (e: any) { fail(res, e); }
};
