/**
 * Media storage driver (m0-technical-spec §3): `local` writes under .data/uploads
 * (dev); `s3` issues presigned PUT URLs and serves via CloudFront (prod).
 */
import { env } from "@gigit/db";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
// Audio is stored as-is — no transcode service (engineering-spec K8).
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const AUDIO_TYPES = ["audio/mpeg", "audio/mp4", "audio/x-m4a"];
export const PER_PROFILE_IMAGE_QUOTA = 20;
export const PER_PROFILE_AUDIO_QUOTA = 10;
export const PER_PROFILE_EMBED_QUOTA = 5;

export function mediaKindFor(contentType: string): "image" | "audio" | null {
  if (IMAGE_TYPES.includes(contentType)) return "image";
  if (AUDIO_TYPES.includes(contentType)) return "audio";
  return null;
}

export interface UploadTarget {
  /** where the client should send the bytes */
  uploadUrl: string;
  method: "PUT";
  storageKey: string;
  /** headers the client must send (s3 driver: content-type + content-length) */
  headers?: Record<string, string>;
}

let s3: S3Client | undefined;
function s3Client(): S3Client {
  // WHEN_SUPPORTED (the SDK default) hoists a CRC32 of the empty body into the
  // signed query string, where a client can't correct it. S3 tolerates it, but
  // there's nothing to gain from signing a checksum of a body we don't have.
  s3 ??= new S3Client({
    region: env().AWS_REGION,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return s3;
}

/**
 * A presigned upload target.
 *
 * `bytes` is signed into the grant, not merely echoed back. Without it the
 * signature covered only bucket + key + expiry, so the size the client declared
 * at presign time was advisory: it could declare 1 byte and PUT 5 GiB, and
 * nothing downstream ever reconciled the two (the row kept the declared size,
 * and the worker read the object fully into memory). Signing content-length
 * makes S3 itself reject a body of any other length — verified against the real
 * bucket: an oversize PUT against a length-signed grant returns 403.
 *
 * Note content-type is NOT signable for a presigned PUT (the presigner adds it
 * to unsignableHeaders), so the stored type is still client-chosen and the
 * worker has to be the authority on that.
 */
export async function uploadTargetFor(
  mediaId: string,
  contentType: string,
  bytes: number,
): Promise<UploadTarget> {
  const ext = extFor(contentType);
  if (env().STORAGE_DRIVER === "s3") {
    const storageKey = `media/${mediaId}.${ext}`;
    const uploadUrl = await getSignedUrl(
      s3Client(),
      new PutObjectCommand({
        Bucket: env().S3_BUCKET!,
        Key: storageKey,
        ContentType: contentType,
        ContentLength: bytes,
      }),
      { expiresIn: 600, signableHeaders: new Set(["content-length"]) },
    );
    return {
      uploadUrl,
      method: "PUT",
      storageKey,
      headers: { "content-type": contentType, "content-length": String(bytes) },
    };
  }
  return {
    uploadUrl: `/api/media/${mediaId}/upload`,
    method: "PUT",
    storageKey: `local/${mediaId}.${ext}`,
  };
}

export async function localWrite(storageKey: string, bytes: Buffer): Promise<void> {
  const root = path.join(process.cwd(), ".data", "uploads");
  const file = path.join(root, path.basename(storageKey));
  await mkdir(root, { recursive: true });
  await writeFile(file, bytes);
}

/** Public URL for a ready asset. Local: dev file route. S3: CDN or signed GET. */
export function localPublicPath(storageKey: string): string {
  return `/api/media/file/${path.basename(storageKey)}`;
}

export async function publicMediaUrl(storageKey: string): Promise<string> {
  if (env().STORAGE_DRIVER === "s3") {
    const cdn = process.env.MEDIA_CDN_URL;
    if (cdn) return `${cdn.replace(/\/$/, "")}/${storageKey}`;
    return getSignedUrl(
      s3Client(),
      new GetObjectCommand({ Bucket: env().S3_BUCKET!, Key: storageKey }),
      { expiresIn: 3600 },
    );
  }
  return localPublicPath(storageKey);
}

function extFor(contentType: string): string {
  return (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/x-m4a": "m4a",
    }[contentType] ?? "bin"
  );
}
