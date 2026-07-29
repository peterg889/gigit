import { appendEvent, db, schema } from "@gigit/db";
import { and, eq, isNull } from "drizzle-orm";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Claim an open support request. The conditional update makes two-admin races safe. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const adminId = await requireUser();
    if (!(await isAdmin(adminId))) return fail("forbidden", "That page is for EightGig staff.", 403);

    const d = db();
    const outcome = await d.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.supportRequests.id })
        .from(schema.supportRequests)
        .where(eq(schema.supportRequests.id, id));
      if (!existing) return { kind: "not_found" } as const;

      const now = new Date();
      const [claimed] = await tx
        .update(schema.supportRequests)
        .set({ claimedByUserId: adminId, claimedAt: now })
        .where(
          and(
            eq(schema.supportRequests.id, id),
            eq(schema.supportRequests.status, "open"),
            isNull(schema.supportRequests.claimedByUserId),
          ),
        )
        .returning({
          id: schema.supportRequests.id,
          status: schema.supportRequests.status,
          claimedByUserId: schema.supportRequests.claimedByUserId,
          claimedAt: schema.supportRequests.claimedAt,
        });
      if (!claimed) return { kind: "conflict" } as const;

      await tx.insert(schema.supportRequestNotes).values({
        supportRequestId: id,
        authorUserId: adminId,
        kind: "claim",
      });
      await appendEvent(tx, {
        actor: adminId,
        kind: "support.claimed",
        subjectType: "support_request",
        subjectId: id,
      });
      return { kind: "ok", request: claimed } as const;
    });

    if (outcome.kind === "not_found")
      return fail("not_found", "We couldn't find that support request.", 404);
    if (outcome.kind === "conflict")
      return fail("conflict", "Someone on the team already picked this up.", 409);
    return ok(outcome.request);
  } catch (e) {
    return respondError(e);
  }
}
