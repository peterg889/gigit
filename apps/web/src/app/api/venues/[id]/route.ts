import { venueUpdateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  // Public profile: project only public columns. Never serialize ownerUserId or
  // the Stripe identifiers (stripeCustomerId / defaultPaymentMethodId) to an
  // unauthenticated caller — mirrors the column projection in performers/search.
  const [v] = await db()
    .select({
      id: schema.venues.id,
      kind: schema.venues.kind,
      name: schema.venues.name,
      bio: schema.venues.bio,
      metro: schema.venues.metro,
      addressLine1: schema.venues.addressLine1,
      addressLine2: schema.venues.addressLine2,
      city: schema.venues.city,
      region: schema.venues.region,
      postalCode: schema.venues.postalCode,
      timeZone: schema.venues.timeZone,
      capacity: schema.venues.capacity,
      paInventory: schema.venues.paInventory,
      noiseCurfew: schema.venues.noiseCurfew,
      reliabilityStrikes: schema.venues.reliabilityStrikes,
      createdAt: schema.venues.createdAt,
    })
    .from(schema.venues)
    .where(eq(schema.venues.id, id));
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
    return respondError(e);
  }
}
