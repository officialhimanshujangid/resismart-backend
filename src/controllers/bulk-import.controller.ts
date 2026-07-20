import { Request, Response } from 'express';
import * as bulkImport from '../services/bulk-import.service';
import { ImportError, ImportKind, IMPORT_KINDS } from '../services/bulk-import.service';
import mongoose from 'mongoose';
import { Block } from '../models/block.model';
import { FlatSize } from '../models/flat-size.model';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

const handler = (fn: (societyId: string, req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      const out = await fn(societyId, req, res);
      // A template writes to the response itself; everything else returns JSON.
      if (!res.headersSent) res.json(out);
    } catch (e: any) {
      if (res.headersSent) return;
      res.status(e instanceof ImportError ? e.status : 400).json({ error: e.message });
    }
  };

/** The URL segment is user input — never trust it as a kind. */
const kindOf = (req: Request): ImportKind => {
  const k = String(req.params.kind || '').toUpperCase().replace(/-/g, '_') as ImportKind;
  if (!IMPORT_KINDS.includes(k)) {
    throw new ImportError(`Unknown import type "${req.params.kind}". Expected one of: ${IMPORT_KINDS.join(', ')}`, 404);
  }
  return k;
};

/**
 * Two doors into the same parser: a pasted CSV in the JSON body, or an uploaded
 * file. Multer only touches multipart requests, so both land here intact.
 */
const sourceOf = (req: Request): bulkImport.ImportSource => ({
  csvText: typeof req.body?.csvText === 'string' ? req.body.csvText : undefined,
  fileBuffer: req.file?.buffer,
});

/** GET /finance/society/import/:kind/template — a blank workbook to fill in. */
export const template = handler(async (societyId, req, res) => {
  const kind = kindOf(req);
  // The dropdowns come from this society's own records, so the list a
  // treasurer picks from is always the list the import will accept.
  const sid = new mongoose.Types.ObjectId(societyId);
  const [blocks, sizes] = await Promise.all([
    Block.find({ societyId: sid }).select('name').sort({ name: 1 }).lean(),
    FlatSize.find({ societyId: sid }).select('name').sort({ name: 1 }).lean(),
  ]);
  const buffer = await bulkImport.templateFor(kind, {
    blocks: blocks.map(b => b.name),
    flatSizes: sizes.map(s => s.name),
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="resismart-${kind.toLowerCase().replace(/_/g, '-')}-template.xlsx"`);
  res.status(200).send(buffer);
});

/** POST /finance/society/import/:kind/preview — dry run. Writes nothing. */
export const preview = handler((societyId, req) =>
  bulkImport.preview(societyId, kindOf(req), sourceOf(req)));

/** POST /finance/society/import/:kind/commit — apply it, all or nothing. */
export const commit = handler((societyId, req) =>
  bulkImport.commit(societyId, kindOf(req), sourceOf(req), actorOf(req), {
    // Multipart sends every field as text, so 'true' has to count as true.
    force: req.body?.force === true || req.body?.force === 'true',
  }));
