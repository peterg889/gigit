import {
  InvalidOfferTermsError,
  SlotUnavailableError,
  createOffer,
  db,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ performerId: z.string().min(1) });

/**
 * Invite an act to an open date — one step, straight onto the offer rail.
 *
 * Two shipped notification templates (`new_act`, `slot_quiet`) tell venues to
 * "send an invite", and `/performers` is commented "search + invite (PRD F2.4)",
 * but no invite endpoint existed. The only available action was a free-text DM
 * whose own placeholder pushed terms into unstructured chat
 * ("Friday the 26th, 8-10pm, $400 — interested?"), after which the act had to go
 * find the slot and apply before the venue could offer at all. Both cold-start
 * nudges dead-ended there — which matters most in exactly the situation this
 * exists for: an open night with zero applicants.
 *
 * This reuses createOffer, so the terms come from the slot rather than from
 * typing, the act reviews a firm offer like any other, and the whole thing stays
 * auditable. The pay is the pay the venue already published.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: slotId } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "You need a venue profile to do that.", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { performerId } = parsed.data;

    const d = db();
    const [slot] = await d
      .select()
      .from(schema.slots)
      .where(
        and(eq(schema.slots.id, slotId), gte(schema.slots.startsAt, new Date())),
      );
    if (!slot) return fail("not_found", "We couldn't find that date.", 404);
    if (slot.venueId !== venue.id)
      return fail("forbidden", "That date isn't yours.", 403);
    if (slot.status !== "open")
      return fail("conflict", "This date is no longer open.", 409);

    const [performer] = await d
      .select({ id: schema.performers.id, status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    if (!performer || performer.status !== "live")
      return fail("not_found", "We couldn't find that act.", 404);

    // A venue-initiated application, then a firm offer on it — the same rails an
    // act's own application takes, so nothing downstream has to know the
    // difference. An act who already applied keeps their existing application.
    const existing = await d
      .select({ id: schema.applications.id, status: schema.applications.status })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.slotId, slotId),
          eq(schema.applications.performerId, performerId),
        ),
      );
    let applicationId = existing[0]?.id;
    if (!applicationId) {
      applicationId = newId("application");
      try {
        await d.insert(schema.applications).values({
          id: applicationId,
          slotId,
          performerId,
          status: "submitted",
        });
      } catch (err) {
        // They applied between the read and the insert — use theirs.
        if ((err as { code?: string })?.code !== "23505") throw err;
        const [raced] = await d
          .select({ id: schema.applications.id })
          .from(schema.applications)
          .where(
            and(
              eq(schema.applications.slotId, slotId),
              eq(schema.applications.performerId, performerId),
            ),
          );
        applicationId = raced!.id;
      }
    } else if (existing[0]!.status !== "submitted") {
      // Revive a withdrawn or passed-over application rather than dead-ending:
      // inviting somebody is a clear signal the venue wants them now.
      await d
        .update(schema.applications)
        .set({ status: "submitted", declineReason: null })
        .where(eq(schema.applications.id, applicationId));
    }

    const endsAt = new Date(slot.startsAt.getTime() + slot.durationMinutes * 60_000);
    const bookingId = await createOffer({
      applicationId,
      slotId,
      performerId,
      venueId: venue.id,
      actor: userId,
      terms: {
        amountCents: slot.budgetCents,
        startsAt: slot.startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        provides: slot.provides,
        ...(slot.notes ? { notes: slot.notes } : {}),
      },
    });
    return ok({ bookingId, applicationId }, 201);
  } catch (e) {
    if (e instanceof SlotUnavailableError)
      return fail(
        "conflict",
        "Someone else already has a live offer on this date. Withdraw it first.",
        409,
      );
    if (e instanceof InvalidOfferTermsError)
      return fail("invalid_offer_terms", e.message, 422);
    return respondError(e);
  }
}
