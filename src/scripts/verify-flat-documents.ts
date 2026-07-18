/**
 * Phase 2 — flat documents. Real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 * The access-control assertions are the point of this suite: these are title
 * deeds, and the failure that matters is one flat's papers being readable from
 * another flat's session.
 *
 *   npx ts-node src/scripts/verify-flat-documents.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { Resident } from '../models/resident.model';
import { UserRole } from '../constants/roles';
import {
  addFlatDocument, listFlatDocuments, removeFlatDocument, flatDocumentDownloadUrl, flatDocumentAccess,
} from '../services/flat-document.service';
import { list as listCtrl, download as downloadCtrl } from '../controllers/flat-document.controller';
import { addFlatDocumentSchema } from '../validators/flat-document.validator';

const societyId = new mongoose.Types.ObjectId();
const otherSociety = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Secretary', role: UserRole.SOCIETY_ADMIN };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const refuses = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try { await fn(); return null; } catch (e: any) { return e; }
};

const mockRes = () => {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};

async function cleanup() {
  const all = { $in: [societyId, otherSociety] };
  await Promise.all([Flat.deleteMany({ societyId: all }), Block.deleteMany({ societyId: all }), Resident.deleteMany({ societyId: all })]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const blockId = new mongoose.Types.ObjectId();
    await Block.create([{ _id: blockId, name: 'A', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName }]);
    const mk = (n: string, sid: mongoose.Types.ObjectId) => ({
      number: n, blockName: 'A', blockId, societyId: sid, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    const [flatA, flatB] = await Flat.create([mk('101', societyId), mk('102', societyId)]);
    const [foreignFlat] = await Flat.create([mk('999', otherSociety)]);

    // ==================================================== validation
    console.log('Only a real, named document is accepted');
    ok('a document with no name is refused',
      !addFlatDocumentSchema.safeParse({ label: '', key: 'flat-documents/x.pdf', url: 'https://s3/x.pdf' }).success);
    ok('a bad url is refused',
      !addFlatDocumentSchema.safeParse({ label: 'Deed', key: 'flat-documents/x.pdf', url: 'not-a-url' }).success);
    ok('an unknown kind is refused',
      !addFlatDocumentSchema.safeParse({ kind: 'RANDOM', label: 'Deed', key: 'flat-documents/x.pdf', url: 'https://s3/x.pdf' }).success);
    ok('a proper document is accepted',
      addFlatDocumentSchema.safeParse({ kind: 'SALE_DEED', label: 'Sale Deed', key: 'flat-documents/x.pdf', url: 'https://s3/x.pdf' }).success);

    // ==================================================== attach
    console.log('\nAttaching papers to the flat');
    const deed = await addFlatDocument(SID, String(flatA._id), {
      kind: 'SALE_DEED', label: 'Sale Deed 2019', key: 'flat-documents/deed-abc.pdf', url: 'https://s3.example/deed-abc.pdf',
    }, actor);
    eq('the document is recorded', deed.label, 'Sale Deed 2019');
    eq('...under the kind chosen', deed.kind, 'SALE_DEED');
    eq('...stamped with who uploaded it', deed.uploadedByName, 'Secretary');
    ok('...and when', !!deed.uploadedAt);

    ok('the S3 key is NOT handed to the client',
      !JSON.stringify(deed).includes('flat-documents/deed-abc.pdf'),
      'the raw object key leaked — that is an invitation to fetch it directly');

    await addFlatDocument(SID, String(flatA._id), {
      kind: 'FLOOR_PLAN', label: 'Floor plan', key: 'flat-documents/plan-1.pdf', url: 'https://s3.example/plan-1.pdf',
    }, actor);
    const listA = await listFlatDocuments(SID, String(flatA._id), actor);
    eq('both documents are listed', listA.length, 2);
    eq('newest first', listA[0].label, 'Floor plan');

    // Audit columns on the flat itself must move.
    const flatAfter = await Flat.findById(flatA._id).lean();
    eq('the flat records who last touched it', flatAfter?.updatedByName, 'Secretary');

    // ==================================================== the key guard
    console.log('\nA file we did not upload cannot be attached');
    const foreignKey = await refuses(() => addFlatDocument(SID, String(flatA._id), {
      label: 'Someone else\'s file', key: 'invoices/other-society-secret.pdf', url: 'https://s3.example/x.pdf',
    }, actor));
    ok('an arbitrary bucket key is refused', !!foreignKey,
      'any object in the bucket could otherwise be attached, then read back through the signed-download route');
    ok('...with a reason', /uploaded through/i.test(foreignKey?.message || ''), foreignKey?.message);

    const emptyKey = await refuses(() => addFlatDocument(SID, String(flatA._id), {
      label: 'No key', key: '', url: 'https://s3.example/x.pdf',
    }, actor));
    ok('an empty key is refused', !!emptyKey);

    // ==================================================== tenant isolation
    console.log('\nOne society cannot reach another\'s papers');
    const foreignRead = await refuses(() => listFlatDocuments(SID, String(foreignFlat._id), actor));
    ok('a flat id from another society is a 404, not a leak', !!foreignRead);
    eq('...specifically 404', (foreignRead as any)?.status, 404);

    const foreignAttach = await refuses(() => addFlatDocument(SID, String(foreignFlat._id), {
      label: 'x', key: 'flat-documents/x.pdf', url: 'https://s3.example/x.pdf',
    }, actor));
    ok('...and cannot be written to', !!foreignAttach);

    const foreignDelete = await refuses(() => removeFlatDocument(SID, String(foreignFlat._id), String(deed._id), actor));
    ok('...nor deleted from', !!foreignDelete);

    // A document id from flat A must not be readable through flat B.
    const crossFlat = await refuses(() => flatDocumentDownloadUrl(SID, String(flatB._id), deed._id, actor));
    ok('a document id cannot be read through a different flat', !!crossFlat,
      'flat B could otherwise download flat A\'s sale deed by guessing the id');

    // ==================================================== owner vs tenant
    //
    // The distinction that matters: a sale deed carries the purchase price. The
    // owner's own household may see it; the tenant living there — and the
    // tenant's family — may not.
    console.log('\nOwner may see and add; tenant may not');
    const ownerId = new mongoose.Types.ObjectId();
    const tenantId = new mongoose.Types.ObjectId();
    const ownerSonId = new mongoose.Types.ObjectId();
    const tenantWifeId = new mongoose.Types.ObjectId();

    const mkResident = (uid: mongoose.Types.ObjectId, flat: any, household: 'OWNER' | 'TENANT', relationship: string) => ({
      flatId: flat._id, societyId, userId: uid,
      person: { name: relationship }, relationship, householdType: household,
      isOwner: relationship === 'OWNER', isActive: true,
      createdBy: userId, createdByName: actor.userName,
      updatedBy: userId, updatedByName: actor.userName,
    });
    await Resident.create([
      mkResident(ownerId, flatA, 'OWNER', 'OWNER'),
      mkResident(ownerSonId, flatA, 'OWNER', 'CHILD'),
      mkResident(tenantId, flatA, 'TENANT', 'TENANT'),
      mkResident(tenantWifeId, flatA, 'TENANT', 'SPOUSE'),
    ]);

    const owner = { userId: ownerId.toString(), userName: 'Asha Rao', role: UserRole.RESIDENT_OWNER };
    const ownerSon = { userId: ownerSonId.toString(), userName: 'Rohit Rao', role: UserRole.FAMILY_MEMBER };
    const tenant = { userId: tenantId.toString(), userName: 'Mahesh', role: UserRole.RESIDENT_TENANT };
    const tenantWife = { userId: tenantWifeId.toString(), userName: 'Sunita', role: UserRole.FAMILY_MEMBER };

    const ownerAccess = await flatDocumentAccess(SID, String(flatA._id), owner);
    ok('the owner may view', ownerAccess.canView);
    ok('...and add their own papers', ownerAccess.canUpload);
    ok('...and undo their own upload', ownerAccess.canDeleteOwn);
    ok('...but not remove what the society filed', !ownerAccess.canDeleteAny);

    const tenantAccess = await flatDocumentAccess(SID, String(flatA._id), tenant);
    ok('the TENANT cannot view the deed at all', !tenantAccess.canView,
      'a sale deed shows the purchase price — not the tenant\'s business');
    ok('...nor upload', !tenantAccess.canUpload);

    const wifeAccess = await flatDocumentAccess(SID, String(flatA._id), tenantWife);
    ok('a tenant\'s family is excluded too', !wifeAccess.canView,
      'checking the role alone would have let this through');

    const sonAccess = await flatDocumentAccess(SID, String(flatA._id), ownerSon);
    ok('the owner\'s own family may view', sonAccess.canView);
    ok('...but not upload', !sonAccess.canUpload);

    const committee = { userId: userId.toString(), userName: 'Treasurer', role: UserRole.SOCIETY_COMMITTEE };
    const cttAccess = await flatDocumentAccess(SID, String(flatA._id), committee);
    ok('the committee may file papers', cttAccess.canUpload);
    ok('...but not remove them', !cttAccess.canDeleteAny && !cttAccess.canDeleteOwn);

    console.log('\nThe rules actually bite on the operations');
    const tenantRead = await refuses(() => listFlatDocuments(SID, String(flatA._id), tenant));
    ok('a tenant listing is refused', !!tenantRead);
    eq('...with 403, not an empty list', (tenantRead as any)?.status, 403);

    const tenantDl = await refuses(() => flatDocumentDownloadUrl(SID, String(flatA._id), deed._id, tenant));
    ok('a tenant download is refused', !!tenantDl);
    eq('...also 403', (tenantDl as any)?.status, 403);

    const ownerUpload = await addFlatDocument(SID, String(flatA._id), {
      kind: 'NOC', label: 'Bank NOC', key: 'flat-documents/noc-1.pdf', url: 'https://s3.example/noc-1.pdf',
    }, owner);
    eq('the owner CAN upload — the whole point of this change', ownerUpload.label, 'Bank NOC');
    eq('...stamped with their name', ownerUpload.uploadedByName, 'Asha Rao');

    const tenantUpload = await refuses(() => addFlatDocument(SID, String(flatA._id), {
      label: 'x', key: 'flat-documents/x.pdf', url: 'https://s3.example/x.pdf',
    }, tenant));
    ok('a tenant cannot upload', !!tenantUpload);

    console.log('\nAn owner may undo their own upload, nothing else');
    const notMine = await refuses(() => removeFlatDocument(SID, String(flatA._id), deed._id, owner));
    ok('the owner cannot remove the society\'s deed', !!notMine,
      'otherwise an inconvenient paper could quietly disappear');
    ok('...and is told why', /only remove documents you uploaded/i.test(notMine?.message || ''), notMine?.message);

    const mine = await removeFlatDocument(SID, String(flatA._id), ownerUpload._id, owner);
    eq('...but can remove their own', mine.label, 'Bank NOC');

    console.log('\nThe list tells each viewer what they may remove');
    const ownerList = await listFlatDocuments(SID, String(flatA._id), owner);
    ok('the owner sees no bin on the society\'s papers', ownerList.every(d => d.canRemove === false));
    const adminList2 = await listFlatDocuments(SID, String(flatA._id), actor);
    ok('the admin sees a bin on everything', adminList2.every(d => d.canRemove === true));

    // ==================================================== resident scoping
    console.log('\nA resident sees their own flat and no other');
    const residentReq = (unitId: string, urlFlatId: string) => ({
      user: { activeTenantId: SID, userId: owner.userId, userName: 'Owner', activeRole: 'RESIDENT_OWNER', activeUnitId: unitId },
      params: { flatId: urlFlatId },
      body: {}, query: {},
    }) as any;

    // The owner of flat A asks for flat B's documents in the URL. They are not a
    // resident of B at all, so the answer is a refusal, not B's papers.
    const sneaky = mockRes();
    await listCtrl(residentReq(String(flatB._id), String(flatA._id)), sneaky);
    eq('naming another flat in the URL gets nothing', sneaky.statusCode, 403);

    const ownDocs = mockRes();
    await listCtrl(residentReq(String(flatA._id), String(flatB._id)), ownDocs);
    eq('their own flat is served regardless of the URL', ownDocs.body?.length, 2);

    const sneakyDl = mockRes();
    await downloadCtrl(
      { ...residentReq(String(flatB._id), String(flatA._id)), params: { flatId: String(flatA._id), docId: deed._id } },
      sneakyDl,
    );
    ok('a resident cannot download through another flat', sneakyDl.statusCode >= 400);

    // An admin may legitimately name any flat in their own society.
    const adminReq = {
      user: { activeTenantId: SID, userId: actor.userId, userName: 'Secretary', activeRole: 'SOCIETY_ADMIN' },
      params: { flatId: String(flatA._id) }, body: {}, query: {},
    } as any;
    const adminList = mockRes();
    await listCtrl(adminReq, adminList);
    eq('an admin can read any flat in their society', adminList.body?.length, 2);

    // ==================================================== removal
    console.log('\nRemoving a document');
    const gone = await removeFlatDocument(SID, String(flatA._id), deed._id, actor);
    eq('it reports what went', gone.label, 'Sale Deed 2019');
    const afterDelete = await listFlatDocuments(SID, String(flatA._id), actor);
    eq('one document remains', afterDelete.length, 1);
    eq('...the other one', afterDelete[0].label, 'Floor plan');

    const twice = await refuses(() => removeFlatDocument(SID, String(flatA._id), deed._id, actor));
    ok('removing it again is a clean 404, not a crash', !!twice);
    eq('...specifically 404', (twice as any)?.status, 404);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
