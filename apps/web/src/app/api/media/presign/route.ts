import { newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { performerOwnedBy, requireUser, respondError, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import {
  AUDIO_MAX_BYTES,
  AUDIO_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  PER_PROFILE_AUDIO_QUOTA,
  PER_PROFILE_IMAGE_QUOTA,
  mediaKindFor,
  uploadTargetFor,
} from "@/lib/storage";

const presignSchema = z.object({
  subjectType: z.enum(["performer", "venue", "tech"]),
  contentType: z.string(),
  bytes: z.number().int().min(1),
});

/** Image upload grant (m0-technical-spec §3): quota-checked, type/size constrained. */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const parsed = await parseBody(req, presignSchema);
    if ("response" in parsed) return parsed.response;
    const { subjectType, contentType, bytes } = parsed.data;

    const kind = mediaKindFor(contentType);
    if (!kind)
      return fail(
        "unsupported_type",
        `allowed: ${[...IMAGE_TYPES, ...AUDIO_TYPES].join(", ")}`,
        422,
      );
    const maxBytes = kind === "image" ? IMAGE_MAX_BYTES : AUDIO_MAX_BYTES;
    if (bytes > maxBytes) return fail("too_large", `max ${maxBytes} bytes`, 422);

    const owner =
      subjectType === "performer"
        ? await performerOwnedBy(userId)
        : subjectType === "venue"
          ? await venueOwnedBy(userId)
          : await techOwnedBy(userId);
    if (!owner) return fail("forbidden", `no ${subjectType} profile`, 403);

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
    const quota = kind === "image" ? PER_PROFILE_IMAGE_QUOTA : PER_PROFILE_AUDIO_QUOTA;
    if (existing.length >= quota)
      return fail("quota", `max ${quota} ${kind} files per profile`, 422);

    const id = newId("media");
    const target = await uploadTargetFor(id, contentType);
    await d.insert(schema.mediaAssets).values({
      id,
      ownerUserId: userId,
      subjectType,
      subjectId: owner.id,
      kind,
      storageKey: target.storageKey,
      bytes,
      status: "uploaded",
      position: existing.length,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "media.presigned",
      subjectType: "media",
      subjectId: id,
    });
    return ok({ id, ...target }, 201);
  } catch (e) {
    return respondError(e);
  }
}
