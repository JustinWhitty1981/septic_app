import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

/**
 * Object storage, and one decision worth its explanation: nothing here knows
 * the bucket name.
 *
 * The compose stack ships MinIO and `minio-init` makes the bucket once, but the
 * endpoint is plain S3 and production is meant to point at a real S3 (NF-09's
 * secret boundary). If bucket naming lived here — derived from an environment
 * name, say, or hardcoded to the dev bucket — the file that talks bytes to
 * objects would also be the file that encodes which environment you are in.
 * Every caller passes the bucket it read from `S3_BUCKET`, the same variable
 * `minio-init` used to create it, so the bucket is configured in exactly one
 * place (compose / the deploy environment) and this module stays a pipe.
 */
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || 'septic_dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'septic_dev_secret',
  },
});

export function bucket(): string {
  return process.env.S3_BUCKET || 'septic-media-dev';
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client.send(new PutObjectCommand({
    Bucket: bucket(), Key: key, Body: body, ContentType: contentType,
  }));
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return await res.Body!.transformToByteArray().then((b) => Buffer.from(b));
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}
