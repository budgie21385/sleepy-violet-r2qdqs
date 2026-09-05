// R2 CLIENT (Aug 30, 2026 — stage 1 of the media migration). One S3 client
// for the Cloudflare R2 bucket that holds photo ORIGINALS. Web derivatives
// and video originals stay on Supabase this stage.
//
// Env (Vercel): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET. `r2Ready()` false = env unset = callers no-op and the client
// falls back to Supabase, so deploys are safe before the bucket exists.
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const R2_BUCKET = process.env.R2_BUCKET || "";

export function r2Ready() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    R2_BUCKET
  );
}

let client = null;
export function r2Client() {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export function presignGet(key, ttlSeconds = 3600) {
  return getSignedUrl(
    r2Client(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: ttlSeconds }
  );
}

export function presignPut(key, contentType, ttlSeconds = 900) {
  return getSignedUrl(
    r2Client(),
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    }),
    { expiresIn: ttlSeconds }
  );
}

export function r2Delete(key) {
  return r2Client().send(
    new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })
  );
}

// ---- Public venue-photo bucket (Sep 5 — the July 10 storage-squeeze cap
// died with the migration; venue photos are public Google-attributed
// content, so they serve straight off R2's public URL, no signing). ----
export const R2_VENUES_BUCKET = process.env.R2_VENUES_BUCKET || "";
export const R2_VENUES_PUBLIC_BASE = (process.env.R2_VENUES_PUBLIC_BASE || "").replace(/\/$/, "");

export function r2VenuesReady() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    R2_VENUES_BUCKET &&
    R2_VENUES_PUBLIC_BASE
  );
}

export function r2PutPublic(key, body, contentType) {
  return r2Client().send(
    new PutObjectCommand({
      Bucket: R2_VENUES_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "image/jpeg",
    })
  );
}

// ---- Multipart (stage 2: video originals) ----------------------------------
export async function multipartInit(key, contentType) {
  const out = await r2Client().send(
    new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType || "video/mp4",
    })
  );
  return out.UploadId;
}

export function presignPart(key, uploadId, partNumber, ttlSeconds = 3600) {
  return getSignedUrl(
    r2Client(),
    new UploadPartCommand({
      Bucket: R2_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: ttlSeconds }
  );
}

export function multipartComplete(key, uploadId, parts) {
  return r2Client().send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

export function multipartAbort(key, uploadId) {
  return r2Client().send(
    new AbortMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  );
}
