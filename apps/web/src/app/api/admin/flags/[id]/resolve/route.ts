import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ action: z.enum(["clear", "uphold"]) });

/**
 * Moderation queue resolution (F9.3): clear = flag dismissed and any held
 * media released; uphold = media blocked. A person decides — always.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const adminId = await requireAdmin();

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { action } = parsed.data;

    const d = db();
    const [flagRow] = await d
      .select()
      .from(schema.fraudFlags)
      .where(eq(schema.fraudFlags.id, id));
    if (!flagRow) return fail("not_found", "We couldn't find that flag.", 404);
    if (flagRow.state !== "open") return fail("conflict", "Someone already resolved this flag.", 409);

    await d
      .update(schema.fraudFlags)
      .set({ state: action === "clear" ? "cleared" : "upheld" })
      .where(eq(schema.fraudFlags.id, id));

    if (flagRow.subjectType === "media") {
      const [asset] = await d
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, flagRow.subjectId));
      if (asset) {
        // 'held' / 'blocked', not the retired 'processing' / 'rejected':
        // migration 0033 renamed the media lifecycle when uploads went away and
        // added a CHECK constraint, so writing the old names here no longer
        // half-works — upholding a flag would throw at the insert and leave the
        // moderator staring at a 500 with the flag still open.
        if (action === "clear" && asset.status === "held")
          await d
            .update(schema.mediaAssets)
            .set({ status: "ready" })
            .where(eq(schema.mediaAssets.id, asset.id));
        if (action === "uphold" && asset.status !== "blocked")
          await d
            .update(schema.mediaAssets)
            .set({ status: "blocked" })
            .where(eq(schema.mediaAssets.id, asset.id));
      }
    }

    await appendEvent(d, {
      actor: adminId,
      kind: `flag.${action === "clear" ? "cleared" : "upheld"}`,
      subjectType: flagRow.subjectType,
      subjectId: flagRow.subjectId,
      payload: { flagId: id, flagKind: flagRow.kind },
    });
    return ok({ id, state: action === "clear" ? "cleared" : "upheld" });
  } catch (e) {
    return respondError(e);
  }
}
