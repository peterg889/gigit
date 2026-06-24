/**
 * Media trust pipeline (PRD F7.5, engineering-spec §8, technical-design §7.4):
 * runs on `media.screen_requested` — the ONLY path to `ready`.
 *
 *   1. content-type sniff (magic bytes vs claimed kind) — mismatch = rejected
 *   2. images: sharp re-encode (strips EXIF/GPS metadata) written back
 *   3. media_fraud_screen (AI gateway) over metadata → fraud_flags
 *   4. high risk → held in processing for the ops queue; else → ready
 *
 * Virus scanning is a deployment concern (S3 bucket AV / GuardDuty malware
 * scan) — tracked in the runbook, not faked here.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
// sharp is imported lazily where it's used (image renditions) so that merely
// importing this module doesn't load its native binary — whose import-attribute
// syntax also trips some bundlers/loaders. Keeps media.ts/index.ts test-loadable.
import { newId } from "@gigit/domain";
import { appendEvent, db, env, mediaFraudScreen, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { notifyUser } from "./notify.js";

let s3: S3Client | undefined;
const s3c = () => (s3 ??= new S3Client({ region: env().AWS_REGION }));

// Web's local driver writes under <web cwd>/.data/uploads; the worker runs
// from apps/worker, so resolve the sibling by default (dev-only path).
const LOCAL_DIR =
  process.env.MEDIA_LOCAL_DIR ?? path.resolve(process.cwd(), "../web/.data/uploads");

const MAGIC: Array<{ kind: "image" | "audio"; test: (b: Buffer) => boolean }> = [
  { kind: "image", test: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) }, // jpeg
  { kind: "image", test: (b) => b.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary")) },
  { kind: "image", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { kind: "audio", test: (b) => b.subarray(0, 3).toString() === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) }, // mp3
  { kind: "audio", test: (b) => b.subarray(4, 8).toString() === "ftyp" }, // m4a/mp4 container
];

export function sniffKind(bytes: Buffer): "image" | "audio" | "unknown" {
  for (const m of MAGIC) if (m.test(bytes)) return m.kind;
  return "unknown";
}

async function readAsset(storageKey: string): Promise<Buffer> {
  if (env().STORAGE_DRIVER === "s3") {
    const res = await s3c().send(
      new GetObjectCommand({ Bucket: env().S3_BUCKET!, Key: storageKey }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  return readFile(path.join(LOCAL_DIR, path.basename(storageKey)));
}

async function writeAsset(storageKey: string, bytes: Buffer, contentType: string) {
  if (env().STORAGE_DRIVER === "s3") {
    await s3c().send(
      new PutObjectCommand({
        Bucket: env().S3_BUCKET!,
        Key: storageKey,
        Body: bytes,
        ContentType: contentType,
      }),
    );
    return;
  }
  await writeFile(path.join(LOCAL_DIR, path.basename(storageKey)), bytes);
}

async function flag(
  subjectId: string,
  kind: string,
  confidence: number,
  evidence: Record<string, unknown>,
) {
  await db().insert(schema.fraudFlags).values({
    id: newId("media"),
    subjectType: "media",
    subjectId,
    kind,
    confidence,
    evidence,
  });
}

async function setStatus(assetId: string, status: "ready" | "rejected", actor: string) {
  const d = db();
  await d
    .update(schema.mediaAssets)
    .set({ status })
    .where(eq(schema.mediaAssets.id, assetId));
  await appendEvent(d, {
    actor,
    kind: `media.${status}`,
    subjectType: "media",
    subjectId: assetId,
  });
}

/** The screen itself. Idempotent: re-runs on an already-decided asset no-op. */
export async function screenMedia(assetId: string): Promise<void> {
  const d = db();
  const [asset] = await d
    .select()
    .from(schema.mediaAssets)
    .where(eq(schema.mediaAssets.id, assetId));
  if (!asset || asset.status !== "processing") return; // stale/duplicate event

  // Embeds: metadata-only screen (no bytes of ours to inspect).
  if (asset.kind === "video_embed") {
    const risk = await mediaFraudScreen(
      {
        kind: "video_embed",
        embedTitle: asset.embedMeta?.title,
        embedProvider: asset.embedMeta?.provider,
      },
      asset.ownerUserId,
    );
    if (risk.risk !== "low")
      await flag(assetId, "ai_screen", risk.risk === "high" ? 90 : 60, { reasons: risk.reasons });
    if (risk.risk === "high") return; // held in processing for the ops queue
    await setStatus(assetId, "ready", "worker");
    return;
  }

  // Uploads: sniff first — a mismatch is a hard reject, no judgment needed.
  let bytes: Buffer;
  try {
    bytes = await readAsset(asset.storageKey!);
  } catch (err) {
    await flag(assetId, "unreadable", 100, { error: String(err) });
    await setStatus(assetId, "rejected", "worker");
    return;
  }
  const sniffed = sniffKind(bytes);
  if (sniffed !== asset.kind) {
    await flag(assetId, "content_type_mismatch", 100, { claimed: asset.kind, sniffed });
    await setStatus(assetId, "rejected", "worker");
    await notifyUser(asset.ownerUserId, "media_rejected");
    return;
  }

  // Images: re-encode via sharp — drops EXIF/GPS and normalizes the container.
  if (asset.kind === "image") {
    const ext = path.extname(asset.storageKey!).toLowerCase();
    const { default: sharp } = await import("sharp");
    const pipeline = sharp(bytes, { failOn: "error" }).rotate(); // bake orientation, drop metadata
    const out =
      ext === ".png"
        ? await pipeline.png().toBuffer()
        : ext === ".webp"
          ? await pipeline.webp().toBuffer()
          : await pipeline.jpeg({ quality: 88 }).toBuffer();
    await writeAsset(
      asset.storageKey!,
      out,
      ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg",
    );
  }

  const risk = await mediaFraudScreen(
    { kind: asset.kind, bytes: asset.bytes, contentSniff: sniffed },
    asset.ownerUserId,
  );
  if (risk.risk !== "low")
    await flag(assetId, "ai_screen", risk.risk === "high" ? 90 : 60, { reasons: risk.reasons });
  if (risk.risk === "high") return; // held for ops review (auto-block only at very high confidence)
  await setStatus(assetId, "ready", "worker");
}

/** Weekly embed-rot recheck (engineering-spec §8): dead links get flagged. */
export async function recheckEmbeds(): Promise<number> {
  const d = db();
  const embeds = await d
    .select()
    .from(schema.mediaAssets)
    .where(eq(schema.mediaAssets.kind, "video_embed"));
  let dead = 0;
  for (const e of embeds) {
    if (e.status !== "ready" || !e.embedUrl) continue;
    try {
      const res = await fetch(e.embedUrl, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404 || res.status === 410) throw new Error(`gone (${res.status})`);
    } catch (err) {
      dead += 1;
      await flag(e.id, "embed_dead", 80, { url: e.embedUrl, error: String(err) });
      await notifyUser(e.ownerUserId, "embed_dead");
    }
  }
  return dead;
}
