import { applicationCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, pgErrorCode, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { AuthError, performerOwnedBy, requireUser, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** One-tap apply (PRD F2.5). The profile IS the application. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: slotId } = await params;
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "create a performer profile first", 403);

    const d = db();
    const [slot] = await d.select().from(schema.slots).where(eq(schema.slots.id, slotId));
    if (!slot) return fail("not_found", "slot not found", 404);
    if (slot.status !== "open") return fail("conflict", "slot is not open", 409);

    const parsed = await parseBody(req, applicationCreateSchema);
    if ("response" in parsed) return parsed.response;

    const id = newId("application");
    try {
      await d.insert(schema.applications).values({
        id,
        slotId,
        performerId: performer.id,
        note: parsed.data.note ?? null,
      });
    } catch (err) {
      // constraint name is on the wrapped cause; match SQLSTATE 23505 instead
      if (pgErrorCode(err) === "23505")
        return fail("conflict", "you already applied to this slot", 409);
      throw err;
    }
    await appendEvent(d, {
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
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
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
    if (!slot) return fail("not_found", "slot not found", 404);
    if (!venue || venue.id !== slot.venueId)
      return fail("forbidden", "only the slot's venue can view applicants", 403);

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
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
