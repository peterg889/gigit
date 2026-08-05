import {
  performerRateOrderMessage,
  performerRatesAreOrdered,
  performerUpdateSchema,
} from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  // Public profile: project only public columns. Never serialize ownerUserId or
  // stripeAccountId (the Connect payout destination) to an anonymous caller.
  const [p] = await db()
    .select({
      id: schema.performers.id,
      kind: schema.performers.kind,
      name: schema.performers.name,
      bio: schema.performers.bio,
      genreTags: schema.performers.genreTags,
      homeMetro: schema.performers.homeMetro,
      travelRadiusMiles: schema.performers.travelRadiusMiles,
      rateMinCents: schema.performers.rateMinCents,
      rateMaxCents: schema.performers.rateMaxCents,
      setLengthsMinutes: schema.performers.setLengthsMinutes,
      techNeeds: schema.performers.techNeeds,
      reliabilityStrikes: schema.performers.reliabilityStrikes,
      status: schema.performers.status,
      createdAt: schema.performers.createdAt,
    })
    .from(schema.performers)
    .where(and(eq(schema.performers.id, id), eq(schema.performers.status, "live")));
  // The public pages gate on status; these APIs did not, so a deactivated or
  // suspended profile kept serving over the API what the page 404s — for a
  // venue that means a full street address.
  if (!p) return fail("not_found", "We couldn't find that act.", 404);
  return ok({ performer: p });
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    const [p] = await d.select().from(schema.performers).where(eq(schema.performers.id, id));
    if (!p) return fail("not_found", "We couldn't find that act.", 404);
    if (p.ownerUserId !== userId) return fail("forbidden", "That profile isn't yours.", 403);
    const parsed = await parseBody(req, performerUpdateSchema);
    if ("response" in parsed) return parsed.response;
    const updateResult = await d.transaction(async (tx) => {
      // Serialize partial rate edits so two individually valid requests cannot
      // both compare against stale bounds and commit an invalid final pair.
      const [current] = await tx
        .select({
          ownerUserId: schema.performers.ownerUserId,
          rateMinCents: schema.performers.rateMinCents,
          rateMaxCents: schema.performers.rateMaxCents,
        })
        .from(schema.performers)
        .where(eq(schema.performers.id, id))
        .for("update");
      if (!current) return "not_found" as const;
      if (current.ownerUserId !== userId) return "forbidden" as const;

      const nextRates = {
        rateMinCents:
          parsed.data.rateMinCents === undefined
            ? current.rateMinCents
            : parsed.data.rateMinCents,
        rateMaxCents:
          parsed.data.rateMaxCents === undefined
            ? current.rateMaxCents
            : parsed.data.rateMaxCents,
      };
      if (!performerRatesAreOrdered(nextRates)) return "invalid_rates" as const;

      await tx.update(schema.performers).set(parsed.data).where(eq(schema.performers.id, id));
      await appendEvent(tx, {
        actor: userId,
        kind: "performer.updated",
        subjectType: "performer",
        subjectId: id,
        payload: { fields: Object.keys(parsed.data) },
      });
      return "updated" as const;
    });
    if (updateResult === "not_found")
      return fail("not_found", "We couldn't find that act.", 404);
    if (updateResult === "forbidden")
      return fail("forbidden", "That profile isn't yours.", 403);
    if (updateResult === "invalid_rates") {
      return fail("validation", performerRateOrderMessage, 422);
    }
    return ok({ id });
  } catch (e) {
    return respondError(e);
  }
}
