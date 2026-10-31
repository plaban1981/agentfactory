import "server-only";

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
});

const bucket = () => process.env.S3_BUCKET;

export async function putObject(key: string, body: Uint8Array, contentType: string) {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

// Objects are private; the app streams them through its own routes after an access check.
export async function getObject(key: string) {
  const { Body, ContentType } = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!Body) return null;
  return { body: Body.transformToWebStream(), contentType: ContentType ?? "application/octet-stream" };
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
