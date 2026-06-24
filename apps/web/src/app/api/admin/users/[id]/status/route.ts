import { appendEvent, db, schema } from "@gigit/db";
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
    if (!(await isAdmin(adminId))) return fail("forbidden", "admin only", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const d = db();
    const updated = await d
      .update(schema.users)
      .set({ status: parsed.data.status })
      .where(eq(schema.users.id, id))
      .returning({ id: schema.users.id });
    if (updated.length === 0) return fail("not_found", "user not found", 404);

    await appendEvent(d, {
      actor: adminId,
      kind: `user.${parsed.data.status}`,
      subjectType: "user",
      subjectId: id,
    });
    return ok({ id, status: parsed.data.status });
  } catch (e) {
    return respondError(e);
  }
}
