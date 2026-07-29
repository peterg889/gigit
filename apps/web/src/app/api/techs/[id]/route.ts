import { techUpdateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq  } from "drizzle-orm";
import { requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  // Public profile: project only public columns (drop the internal ownerUserId),
  // mirroring techs/list.
  const [t] = await db()
    .select({
      id: schema.techs.id,
      name: schema.techs.name,
      bio: schema.techs.bio,
      gear: schema.techs.gear,
      rateLaborCents: schema.techs.rateLaborCents,
      rateWithRigCents: schema.techs.rateWithRigCents,
      travelRadiusMiles: schema.techs.travelRadiusMiles,
      reliabilityStrikes: schema.techs.reliabilityStrikes,
      createdAt: schema.techs.createdAt,
    })
    .from(schema.techs)
    .where(and(eq(schema.techs.id, id), eq(schema.techs.status, "live")));
  // The public pages gate on status; these APIs did not, so a deactivated or
  // suspended profile kept serving over the API what the page 404s — for a
  // venue that means a full street address.
  if (!t) return fail("not_found", "We couldn't find that sound tech.", 404);
  return ok({ tech: t });
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    const [t] = await d.select().from(schema.techs).where(eq(schema.techs.id, id));
    if (!t) return fail("not_found", "We couldn't find that sound tech.", 404);
    if (t.ownerUserId !== userId) return fail("forbidden", "That profile isn't yours.", 403);
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
    return respondError(e);
  }
}
