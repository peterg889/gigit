import { performerUpdateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { AuthError, requireUser } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const [p] = await db().select().from(schema.performers).where(eq(schema.performers.id, id));
  if (!p) return fail("not_found", "performer not found", 404);
  return ok({ performer: p });
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    const [p] = await d.select().from(schema.performers).where(eq(schema.performers.id, id));
    if (!p) return fail("not_found", "performer not found", 404);
    if (p.ownerUserId !== userId) return fail("forbidden", "not your profile", 403);
    const parsed = await parseBody(req, performerUpdateSchema);
    if ("response" in parsed) return parsed.response;
    await d.update(schema.performers).set(parsed.data).where(eq(schema.performers.id, id));
    await appendEvent(d, {
      actor: userId,
      kind: "performer.updated",
      subjectType: "performer",
      subjectId: id,
      payload: { fields: Object.keys(parsed.data) },
    });
    return ok({ id });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
