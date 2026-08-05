import {
  appendEvent,
  db,
  schema,
  setProfileVisibility,
  suspendAccount,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ status: z.enum(["active", "suspended"]) });

/** Suspend / reinstate an account (F9.1). Suspension bites in requireUser. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const adminId = await requireUser();
    if (!(await isAdmin(adminId))) return fail("forbidden", "That page is for EightGig staff.", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const requestedStatus = parsed.data.status;
    const result =
      requestedStatus === "suspended"
        ? await suspendAccount(id, adminId)
        : await db().transaction(async (tx) => {
            const [current] = await tx
              .select({ status: schema.users.status })
              .from(schema.users)
              .where(eq(schema.users.id, id))
              .for("update");
            if (!current) return "not_found" as const;
            if (current.status === "active") return "unchanged" as const;
            if (current.status !== "suspended")
              return "invalid_transition" as const;

            await tx
              .update(schema.users)
              .set({ status: "active" })
              .where(eq(schema.users.id, id));

            // Reinstatement restores public profiles but intentionally does not
            // resurrect commitments that were closed by the suspension.
            await setProfileVisibility(id, "live", tx);
            await appendEvent(tx, {
              actor: adminId,
              kind: "user.active",
              subjectType: "user",
              subjectId: id,
            });
            return "updated" as const;
          });
    if (result === "not_found")
      return fail("not_found", "We couldn't find that account.", 404);
    if (result === "invalid_transition")
      return fail(
        "conflict",
        "This account has been deactivated and its status can no longer be changed here.",
        409,
      );
    return ok({ id, status: requestedStatus });
  } catch (e) {
    return respondError(e);
  }
}
