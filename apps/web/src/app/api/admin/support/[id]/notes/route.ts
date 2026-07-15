import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ note: z.string().trim().min(1).max(2000) });

/** Add an append-only internal note to an open support request. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const adminId = await requireUser();
    if (!(await isAdmin(adminId))) return fail("forbidden", "admin only", 403);
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const d = db();
    const outcome = await d.transaction(async (tx) => {
      const [request] = await tx
        .select({ status: schema.supportRequests.status })
        .from(schema.supportRequests)
        .where(eq(schema.supportRequests.id, id))
        // Serialize against resolve's conditional UPDATE. Without this lock a
        // note could observe `open`, then be inserted after another transaction
        // has already committed the request as resolved.
        .for("update");
      if (!request) return { kind: "not_found" } as const;
      if (request.status !== "open") return { kind: "conflict" } as const;

      const [note] = await tx
        .insert(schema.supportRequestNotes)
        .values({
          supportRequestId: id,
          authorUserId: adminId,
          kind: "note",
          body: parsed.data.note,
        })
        .returning({
          id: schema.supportRequestNotes.id,
          createdAt: schema.supportRequestNotes.createdAt,
        });
      await appendEvent(tx, {
        actor: adminId,
        kind: "support.note_added",
        subjectType: "support_request",
        subjectId: id,
        payload: { noteId: note!.id },
      });
      return { kind: "ok", note: note! } as const;
    });

    if (outcome.kind === "not_found")
      return fail("not_found", "support request not found", 404);
    if (outcome.kind === "conflict")
      return fail("conflict", "resolved support requests cannot be changed", 409);
    return ok(outcome.note);
  } catch (e) {
    return respondError(e);
  }
}
