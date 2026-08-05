import { applicationCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, lockActiveProfileOwners, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** One-tap apply (PRD F2.5). The profile IS the application. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: slotId } = await params;
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "Create an act profile first.", 403);
    const parsed = await parseBody(req, applicationCreateSchema);
    if ("response" in parsed) return parsed.response;

    return await db().transaction(async (tx) => {
      const [candidate] = await tx
        .select({ venueId: schema.slots.venueId })
        .from(schema.slots)
        .where(eq(schema.slots.id, slotId));
      if (!candidate) return fail("not_found", "We couldn't find that date.", 404);
      await lockActiveProfileOwners(tx, {
        performerIds: [performer.id],
        venueIds: [candidate.venueId],
        additionalUserIds: [userId],
      });
      // A stale page can submit between downbeat and the hourly expiry sweep.
      // Lock and re-check both status and time in the same unit as the insert.
      const [slot] = await tx
        .select()
        .from(schema.slots)
        .where(eq(schema.slots.id, slotId))
        .for("update");
      if (!slot) return fail("not_found", "We couldn't find that date.", 404);
      if (slot.status !== "open")
        return fail("conflict", "This date is no longer open.", 409);
      if (slot.startsAt.getTime() <= Date.now())
        return fail("conflict", "This date has already passed.", 409);

      const candidateId = newId("application");
      const inserted = await tx
        .insert(schema.applications)
        .values({
          id: candidateId,
          slotId,
          performerId: performer.id,
          note: parsed.data.note ?? null,
        })
        .onConflictDoNothing({
          target: [schema.applications.slotId, schema.applications.performerId],
        })
        .returning({ id: schema.applications.id });
      let id = inserted[0]?.id;
      if (!id) {
        // A withdrawn application (performer declined an offer, or withdrew)
        // must not lock the pairing out of a reopened slot forever: re-applying
        // revives it. Anything else on file is a real duplicate.
        const revived = await tx
          .update(schema.applications)
          .set({
            status: "submitted",
            declineReason: null,
            note: parsed.data.note ?? null,
          })
          .where(
            and(
              eq(schema.applications.slotId, slotId),
              eq(schema.applications.performerId, performer.id),
              eq(schema.applications.status, "withdrawn"),
            ),
          )
          .returning({ id: schema.applications.id });
        if (revived.length === 0)
          return fail("conflict", "You've already applied to this date.", 409);
        id = revived[0]!.id;
      }
      await appendEvent(tx, {
        actor: userId,
        kind: "application.submitted",
        subjectType: "slot",
        subjectId: slotId,
        payload: {
          applicationId: id,
          performerId: performer.id,
          effects: [{ kind: "notify", template: "new_application", to: "venue" }],
        },
      });
      return ok({ id }, 201);
    });
  } catch (e) {
    return respondError(e);
  }
}

/** Applicant list — slot's venue owner only (PRD F2.5). */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { id: slotId } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    const d = db();
    const [slot] = await d.select().from(schema.slots).where(eq(schema.slots.id, slotId));
    if (!slot) return fail("not_found", "We couldn't find that date.", 404);
    if (!venue || venue.id !== slot.venueId)
      return fail("forbidden", "Only the venue that posted this date can see who applied.", 403);

    const rows = await d
      .select({ application: schema.applications, performer: schema.performers })
      .from(schema.applications)
      .innerJoin(
        schema.performers,
        eq(schema.applications.performerId, schema.performers.id),
      )
      .where(eq(schema.applications.slotId, slotId));
    return ok({ applications: rows });
  } catch (e) {
    return respondError(e);
  }
}
