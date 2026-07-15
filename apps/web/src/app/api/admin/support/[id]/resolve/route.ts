import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ note: z.string().trim().min(1).max(2000) });

/** Resolve a request only when the current admin owns the claim. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const adminId = await requireUser();
    if (!(await isAdmin(adminId))) return fail("forbidden", "admin only", 403);
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const d = db();
    const outcome = await d.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.supportRequests.id })
        .from(schema.supportRequests)
        .where(eq(schema.supportRequests.id, id));
      if (!existing) return { kind: "not_found" } as const;

      const now = new Date();
      const [resolved] = await tx
        .update(schema.supportRequests)
        .set({
          status: "resolved",
          resolvedByUserId: adminId,
          resolvedAt: now,
        })
        .where(
          and(
            eq(schema.supportRequests.id, id),
            eq(schema.supportRequests.status, "open"),
            eq(schema.supportRequests.claimedByUserId, adminId),
          ),
        )
        .returning({
          id: schema.supportRequests.id,
          status: schema.supportRequests.status,
          resolvedByUserId: schema.supportRequests.resolvedByUserId,
          resolvedAt: schema.supportRequests.resolvedAt,
        });
      if (!resolved) return { kind: "conflict" } as const;

      const [note] = await tx
        .insert(schema.supportRequestNotes)
        .values({
          supportRequestId: id,
          authorUserId: adminId,
          kind: "resolution",
          body: parsed.data.note,
        })
        .returning({ id: schema.supportRequestNotes.id });
      await appendEvent(tx, {
        actor: adminId,
        kind: "support.resolved",
        subjectType: "support_request",
        subjectId: id,
        payload: { noteId: note!.id },
      });
      return { kind: "ok", request: resolved } as const;
    });

    if (outcome.kind === "not_found")
      return fail("not_found", "support request not found", 404);
    if (outcome.kind === "conflict")
      return fail(
        "conflict",
        "claim this open support request before resolving it",
        409,
      );
    return ok(outcome.request);
  } catch (e) {
    return respondError(e);
  }
}
