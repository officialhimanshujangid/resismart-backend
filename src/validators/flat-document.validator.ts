import { z } from 'zod';

export const FLAT_DOCUMENT_KINDS = [
  'SALE_DEED', 'PROPERTY_CARD', 'NOC', 'OC_CERTIFICATE',
  'FLOOR_PLAN', 'SHARE_CERT_COPY', 'POSSESSION_LETTER', 'OTHER',
] as const;

export const addFlatDocumentSchema = z.object({
  kind: z.enum(FLAT_DOCUMENT_KINDS).optional(),
  label: z.string().trim().min(1, 'Give the document a name').max(150),
  // The service additionally checks the key sits under the uploader's own
  // prefix — a well-formed key for somebody else's object is still refused.
  key: z.string().trim().min(1, 'key is required').max(300),
  url: z.string().trim().url('Invalid url'),
});
