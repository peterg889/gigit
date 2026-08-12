import { type MediaKind, embedCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  performerOwnedBy,
  requireUser,
  respondError,
  techOwnedBy,
  venueOwnedBy,
} from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import { fetchEmbedMeta, normalizeEmbedUrl, providerFor } from "@/lib/oembed";

const bodySchema = embedCreateSchema.extend({
  subjectType: z.enum(["performer", "venue", "tech"]).default("performer"),
});

/**
 * Per-profile link quotas, by kind. These are the numbers the upload path
 * carried (20 photos / 10 clips / 5 videos); a link costs us no bytes but an
 * unbounded list is still a way to make a profile page unloadable and to point
 * hundreds of oEmbed fetches wherever the poster likes.
 */
const QUOTA: Record<MediaKind, number> = { photo: 20, audio: 10, video: 5 };

const NOUN: Record<MediaKind, string> = {
  photo: "photos",
  audio: "audio links",
  video: "videos",
};

const PROFILE_NOUN = {
  performer: "act",
  venue: "venue",
  tech: "sound tech",
} as const;

/**
 * Add a media link (engineering-spec §8: media is link-only). Photos, audio and
 * video are all URLs on a third-party host — EightGig stores no user media — so
 * this is the only way anything reaches a profile. The kind is decided by the
 * provider the URL belongs to, never by the client: the host allow-list in
 * @gigit/domain is what keeps an arbitrary URL out of an oEmbed fetch and out of
 * an <img>/<iframe> on a public page.
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { subjectType } = parsed.data;

    // Canonical form: https, lowercase host, no fragment. Stored rather than the
    // raw paste so the same track added twice is the same string — the fragment
    // in particular identifies nothing to a provider but makes ten copies look
    // like ten different links.
    const url = normalizeEmbedUrl(parsed.data.url);
    const match = url ? providerFor(url) : null;
    // Unreachable via the schema (embedCreateSchema runs the same allow-list),
    // but this route must not be the place where a URL no provider claims gets
    // written with a guessed kind if that ever drifts.
    if (!url || !match)
      return fail("unsupported_url", "That link isn't from a site we support.", 422);
    const { kind } = match;

    const owner =
      subjectType === "performer"
        ? await performerOwnedBy(userId)
        : subjectType === "venue"
          ? await venueOwnedBy(userId)
          : await techOwnedBy(userId);
    if (!owner)
      return fail("forbidden", `Create a ${PROFILE_NOUN[subjectType]} profile first.`, 403);

    const d = db();
    const existing = await d
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.subjectType, subjectType),
          eq(schema.mediaAssets.subjectId, owner.id),
          eq(schema.mediaAssets.kind, kind),
        ),
      );
    if (existing.length >= QUOTA[kind])
      return fail(
        "quota",
        `You can have ${QUOTA[kind]} ${NOUN[kind]} on a profile. Remove one to add another.`,
        422,
      );

    const meta = await fetchEmbedMeta(url);
    const id = newId("media");
    await d.insert(schema.mediaAssets).values({
      id,
      ownerUserId: userId,
      subjectType,
      subjectId: owner.id,
      kind,
      embedUrl: url,
      embedMeta: meta
        ? {
            ...(meta.title !== undefined ? { title: meta.title } : {}),
            ...(meta.thumbnailUrl !== undefined
              ? { thumbnailUrl: meta.thumbnailUrl }
              : {}),
            ...(meta.imageUrl !== undefined ? { imageUrl: meta.imageUrl } : {}),
            provider: meta.provider,
          }
        : {},
      status: "held", // screened on metadata before visibility (F7.5)
      position: existing.length,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "media.screen_requested",
      subjectType: "media",
      subjectId: id,
      payload: { url },
    });
    return ok({ id, kind }, 201);
  } catch (e) {
    return respondError(e);
  }
}
