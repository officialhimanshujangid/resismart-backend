import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

  /**
   * Upload an arbitrary buffer (e.g. a generated PDF) and return the public URL.
   */
  async uploadBuffer(buffer: Buffer, keyPrefix: string, extension: string, contentType: string): Promise<string> {
    const fileKey = `${keyPrefix}/${crypto.randomBytes(16).toString('hex')}.${extension}`;

    await this.s3Client.send(new PutObjectCommand({
      Bucket: appConfig.awsS3Bucket,
      Key: fileKey,
      Body: buffer,
      ContentType: contentType,
    }));

    return `https://${appConfig.awsS3Bucket}.s3.${appConfig.awsRegion}.amazonaws.com/${fileKey}`;
  }

  /** Extracts the object key from a full S3 URL produced by this service. */
  keyFromUrl(url: string): string | null {
    try {
      const u = new URL(url);
      return decodeURIComponent(u.pathname.replace(/^\//, '')) || null;
    } catch {
      return null;
    }
  }

  /**
   * Generates a short-lived presigned GET URL for a private object so a logged-in
   * user can download it without the object being publicly readable.
   */
  /**
   * Delete one object.
   *
   * Added for the visitor-photo retention purge: under the DPDP Act personal
   * data has to actually go once its purpose is served, and deleting the
   * database row while leaving the face on S3 would be the worst of both
   * worlds — no record of the visit, and the photograph kept forever.
   *
   * S3 treats deleting a missing key as success, which is the behaviour we
   * want: the desired end state is "not there".
   */
  async deleteObject(key: string): Promise<void> {
    await this.s3Client.send(new DeleteObjectCommand({
      Bucket: appConfig.awsS3Bucket,
      Key: key,
    }));
  }

  async getSignedDownloadUrl(key: string, opts?: { expiresIn?: number; downloadName?: string }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: appConfig.awsS3Bucket,
      Key: key,
      ...(opts?.downloadName ? { ResponseContentDisposition: `inline; filename="${opts.downloadName}"` } : {}),
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: opts?.expiresIn ?? 300 });
  }
}

export default new S3Service();
