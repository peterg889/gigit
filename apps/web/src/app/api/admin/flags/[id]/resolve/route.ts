import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ action: z.enum(["clear", "uphold"]) });

/**
 * Moderation queue resolution (F9.3): clear = flag dismissed and any held
 * media released; uphold = media rejected. A person decides — always.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const adminId = await requireUser();
    if (!(await isAdmin(adminId))) return fail("forbidden", "admin only", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { action } = parsed.data;

    const d = db();
    const [flagRow] = await d
      .select()
      .from(schema.fraudFlags)
      .where(eq(schema.fraudFlags.id, id));
    if (!flagRow) return fail("not_found", "flag not found", 404);
    if (flagRow.state !== "open") return fail("conflict", `flag is ${flagRow.state}`, 409);

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
        if (action === "clear" && asset.status === "processing")
          await d
            .update(schema.mediaAssets)
            .set({ status: "ready" })
            .where(eq(schema.mediaAssets.id, asset.id));
        if (action === "uphold" && asset.status !== "rejected")
          await d
            .update(schema.mediaAssets)
            .set({ status: "rejected" })
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
