import { embedCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import { fetchEmbedMeta } from "@/lib/oembed";
import { PER_PROFILE_EMBED_QUOTA } from "@/lib/storage";

const bodySchema = embedCreateSchema.extend({
  subjectType: z.enum(["performer", "venue", "tech"]).default("performer"),
});

/** Add a YouTube/Vimeo embed (engineering-spec §8: video is embed-only). */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    // M0: embeds on performer profiles (venue/tech embed support is trivial later)
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "performer profile required", 403);

    const d = db();
    const existing = await d
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.subjectType, "performer"),
          eq(schema.mediaAssets.subjectId, performer.id),
          eq(schema.mediaAssets.kind, "video_embed"),
        ),
      );
    if (existing.length >= PER_PROFILE_EMBED_QUOTA)
      return fail("quota", `max ${PER_PROFILE_EMBED_QUOTA} video embeds`, 422);

    const meta = await fetchEmbedMeta(parsed.data.url);
    const id = newId("media");
    await d.insert(schema.mediaAssets).values({
      id,
      ownerUserId: userId,
      subjectType: "performer",
      subjectId: performer.id,
      kind: "video_embed",
      embedUrl: parsed.data.url,
      embedMeta: meta
        ? {
            ...(meta.title !== undefined ? { title: meta.title } : {}),
            ...(meta.thumbnailUrl !== undefined
              ? { thumbnailUrl: meta.thumbnailUrl }
              : {}),
            provider: meta.provider,
          }
        : {},
      status: "processing", // screened on metadata before visibility (F7.5)
      position: existing.length,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "media.screen_requested",
      subjectType: "media",
      subjectId: id,
      payload: { url: parsed.data.url },
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
