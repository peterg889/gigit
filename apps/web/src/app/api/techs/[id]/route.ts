import { techUpdateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { AuthError, requireUser } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const [t] = await db().select().from(schema.techs).where(eq(schema.techs.id, id));
  if (!t) return fail("not_found", "tech not found", 404);
  return ok({ tech: t });
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    const [t] = await d.select().from(schema.techs).where(eq(schema.techs.id, id));
    if (!t) return fail("not_found", "tech not found", 404);
    if (t.ownerUserId !== userId) return fail("forbidden", "not your profile", 403);
    const parsed = await parseBody(req, techUpdateSchema);
    if ("response" in parsed) return parsed.response;
    await d.update(schema.techs).set(parsed.data).where(eq(schema.techs.id, id));
    await appendEvent(d, {
      actor: userId,
      kind: "tech.updated",
      subjectType: "tech",
      subjectId: id,
      payload: { fields: Object.keys(parsed.data) },
    });
    return ok({ id });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
