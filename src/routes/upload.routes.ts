import { Router, Request, Response } from 'express';
import { upload } from '../middlewares/upload.middleware';
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

export default router;
