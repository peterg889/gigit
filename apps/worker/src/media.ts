/**
 * Media trust pipeline (PRD F7.5, engineering-spec §8, technical-design §7.4):
 * runs on `media.screen_requested` — the ONLY path to `ready`.
 *
 *   1. media_fraud_screen (AI gateway) over the link's metadata → fraud_flags
 *   2. high risk → left `held` for the ops queue; else → `ready`
 *
 * There is nothing else left to do here. EightGig stores no user media, so every
 * asset is a link on a third-party host: no bytes of ours to sniff, no EXIF to
 * strip, no object to re-encode and write back. The magic-byte sniff, the sharp
 * re-encode and the audio content-type rewrite went with the upload path they
 * defended — and so did virus scanning as a deployment concern, since we no
 * longer take delivery of a file.
 */
import { newId } from "@gigit/domain";
import { appendEvent, db, mediaFraudScreen, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { notifyUser } from "./notify.js";

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

async function setStatus(assetId: string, status: "ready" | "blocked", actor: string) {
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
  if (!asset || asset.status !== "held") return; // stale/duplicate event

  const risk = await mediaFraudScreen(
    {
      kind: asset.kind,
      embedTitle: asset.embedMeta?.title,
      embedProvider: asset.embedMeta?.provider,
    },
    asset.ownerUserId,
  );
  if (risk.risk !== "low")
    await flag(assetId, "ai_screen", risk.risk === "high" ? 90 : 60, { reasons: risk.reasons });
  if (risk.risk === "high") return; // left held for ops review
  await setStatus(assetId, "ready", "worker");
}

/** Weekly embed-rot recheck (engineering-spec §8): dead links get flagged. */
export async function recheckEmbeds(): Promise<number> {
  const d = db();
  // Every asset is a link now, so there is no kind filter: a dead SoundCloud
  // track or a deleted Flickr photo rots exactly the way a pulled video does,
  // and the old `kind = 'video_embed'` filter would have skipped both.
  const embeds = await d.select().from(schema.mediaAssets);
  let dead = 0;
  for (const e of embeds) {
    if (e.status !== "ready") continue;
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
