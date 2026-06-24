import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { AuthError, requireUser } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Upload complete → screening requested. The worker sniffs, strips EXIF,
 * runs the fraud screen (F7.5), and only IT flips the asset to ready.
 * Nothing is public before screening (technical-design A10).
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    // Atomic, owner-checked advance: only the caller's 'uploaded' asset moves to
    // 'processing' (works for both the local and S3 upload paths). Idempotent —
    // a re-call on an already-advanced asset is a no-op success, not a 409.
    const advanced = await d
      .update(schema.mediaAssets)
      .set({ status: "processing" })
      .where(
        and(
          eq(schema.mediaAssets.id, id),
          eq(schema.mediaAssets.ownerUserId, userId),
          eq(schema.mediaAssets.status, "uploaded"),
        ),
      )
      .returning({ id: schema.mediaAssets.id });

    if (advanced.length > 0) {
      await appendEvent(d, {
        actor: userId,
        kind: "media.screen_requested",
        subjectType: "media",
        subjectId: id,
      });
      return ok({ id, status: "processing" });
    }

    // Nothing advanced: not the caller's asset, or already past 'uploaded'.
    const [asset] = await d
      .select({
        status: schema.mediaAssets.status,
        ownerUserId: schema.mediaAssets.ownerUserId,
      })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, id));
    if (!asset || asset.ownerUserId !== userId)
      return fail("not_found", "media not found", 404);
    return ok({ id, status: asset.status }); // idempotent: already screening/done
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
