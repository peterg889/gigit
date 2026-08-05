import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ action: z.enum(["decline", "withdraw"]) });

/** Venue declines an applicant; performer withdraws an application. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const action = parsed.data.action;
    const [venue, performer] = await Promise.all([
      action === "decline" ? venueOwnedBy(userId) : Promise.resolve(null),
      action === "withdraw" ? performerOwnedBy(userId) : Promise.resolve(null),
    ]);

    return await db().transaction(async (tx) => {
      // Decline, withdraw, offer, and date cancellation all move this row. Lock
      // and re-check so two stale buttons cannot both succeed with contradictory
      // events, or leave an event committed without its matching status.
      const [application] = await tx
        .select()
        .from(schema.applications)
        .where(eq(schema.applications.id, id))
        .for("update");
      if (!application)
        return fail("not_found", "We couldn't find that application.", 404);
      if (application.status !== "submitted")
        return fail("conflict", "This application already has an answer.", 409);

      const [slot] = await tx
        .select({ id: schema.slots.id, venueId: schema.slots.venueId })
        .from(schema.slots)
        .where(eq(schema.slots.id, application.slotId));
      if (!slot) return fail("not_found", "We couldn't find that date.", 404);

      if (action === "decline") {
        if (!venue || venue.id !== slot.venueId)
          return fail("forbidden", "That date isn't yours.", 403);
      } else if (!performer || performer.id !== application.performerId) {
        return fail("forbidden", "That application isn't yours.", 403);
      }

      const status = action === "decline" ? "declined" : "withdrawn";
      await tx
        .update(schema.applications)
        .set({
          status,
          // A venue's deliberate decline is sticky — reopening a cancelled slot
          // revives only the acts that were auto-declined when it filled.
          ...(status === "declined"
            ? { declineReason: "venue_declined" as const }
            : {}),
        })
        .where(eq(schema.applications.id, id));
      await appendEvent(tx, {
        actor: userId,
        kind: `application.${status}`,
        subjectType: "slot",
        subjectId: slot.id,
        payload: {
          applicationId: id,
          // A deliberate decline is news for the act; a withdrawal is the
          // act's own action and does not need a notification.
          ...(status === "declined"
            ? {
                effects: [
                  {
                    kind: "notify",
                    template: "application_not_selected",
                    to: "performer",
                  },
                ],
              }
            : {}),
        },
      });
      return ok({ status });
    });
  } catch (e) {
    return respondError(e);
  }
}
