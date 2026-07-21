import { Router, Request, Response } from 'express';
import { upload, uploadDocument } from '../middlewares/upload.middleware';
import s3Service from '../services/s3.service';
import { authenticateJWT } from '../middlewares/auth.middleware';

const router = Router();

router.post('/', authenticateJWT, upload.single('image'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Please upload an image file.' });
      return;
    }

    const imageUrl = await s3Service.uploadFile(req.file);
    res.status(200).json({ imageUrl });
  } catch (error: any) {
    console.error('Error uploading file to S3:', error);
    res.status(500).json({ error: `S3 Upload Error: ${error.message || error}` });
  }
});

/**
 * Upload a resident/household document (PDF or image) to a PRIVATE prefix. Returns the
 * object `key` (for a later presigned download) and `url`. The URL is not publicly
 * fetchable — downloads go through the presigned-download endpoint.
 */
router.post('/document', authenticateJWT, uploadDocument.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Please upload a PDF or image document.' });
      return;
    }
    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const url = await s3Service.uploadBuffer(req.file.buffer, 'flat-documents', ext, req.file.mimetype);
    const key = s3Service.keyFromUrl(url);
    res.status(200).json({ url, key });
  } catch (error: any) {
    console.error('Error uploading document to S3:', error);
    res.status(500).json({ error: `S3 Upload Error: ${error.message || error}` });
  }
});

/**
 * A staff member's papers — police verification, ID proof, contract.
 *
 * Identical machinery to `/document` above, and a SEPARATE PREFIX on purpose.
 * Documents are attached by key, so if staff and flats shared `flat-documents/`
 * a key handed back by one uploader could be attached through the other and
 * then read back through its download route: a tenant's rental agreement
 * reachable by anybody who can edit a staff record. Two prefixes, and each
 * service refuses a key that is not under its own.
 */
router.post('/staff-document', authenticateJWT, uploadDocument.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Please upload a PDF or image document.' });
      return;
    }
    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const url = await s3Service.uploadBuffer(req.file.buffer, 'staff-documents', ext, req.file.mimetype);
    const key = s3Service.keyFromUrl(url);
    res.status(200).json({ url, key });
  } catch (error: any) {
    console.error('Error uploading staff document to S3:', error);
    res.status(500).json({ error: `S3 Upload Error: ${error.message || error}` });
  }
});

/**
 * A staff member's photograph.
 *
 * Private, unlike `/upload` above, which puts profile pictures under a publicly
 * fetchable `profile-images/` key. A guard's face is personal data and there is
 * no reason for it to be readable by anybody who guesses a URL — it is shown
 * through the presigned `GET /staff/:id/photo` route instead.
 */
router.post('/staff-photo', authenticateJWT, upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Please upload a photograph.' });
      return;
    }
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const url = await s3Service.uploadBuffer(req.file.buffer, 'staff-photos', ext, req.file.mimetype);
    const key = s3Service.keyFromUrl(url);
    res.status(200).json({ url, key });
  } catch (error: any) {
    console.error('Error uploading staff photo to S3:', error);
    res.status(500).json({ error: `S3 Upload Error: ${error.message || error}` });
  }
});

export default router;
