import { venueUpdateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { AuthError, requireUser } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const [v] = await db().select().from(schema.venues).where(eq(schema.venues.id, id));
  if (!v) return fail("not_found", "venue not found", 404);
  return ok({ venue: v });
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    const [v] = await d.select().from(schema.venues).where(eq(schema.venues.id, id));
    if (!v) return fail("not_found", "venue not found", 404);
    if (v.ownerUserId !== userId) return fail("forbidden", "not your venue", 403);
    const parsed = await parseBody(req, venueUpdateSchema);
    if ("response" in parsed) return parsed.response;
    await d.update(schema.venues).set(parsed.data).where(eq(schema.venues.id, id));
    await appendEvent(d, {
      actor: userId,
      kind: "venue.updated",
      subjectType: "venue",
      subjectId: id,
      payload: { fields: Object.keys(parsed.data) },
    });
    return ok({ id });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
