import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { appConfig } from '../config/appConfig';
import crypto from 'crypto';

class S3Service {
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({
      region: appConfig.awsRegion,
      credentials: {
        accessKeyId: appConfig.awsAccessKeyId,
        secretAccessKey: appConfig.awsSecretAccessKey,
      },
    });
  }

  /**
   * Upload a file buffer to S3 and return the public URL
   */
  async uploadFile(file: Express.Multer.File): Promise<string> {
    const fileExtension = file.originalname.split('.').pop() || '';
    const fileKey = `profile-images/${crypto.randomBytes(16).toString('hex')}.${fileExtension}`;

    const params = {
      Bucket: appConfig.awsS3Bucket,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    await this.s3Client.send(new PutObjectCommand(params));

    // Construct public S3 URL
    return `https://${appConfig.awsS3Bucket}.s3.${appConfig.awsRegion}.amazonaws.com/${fileKey}`;
  }
}

export default new S3Service();
