import { newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { requireUser, respondError, techOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Tech one-tap apply — applying to a posted budget is agreeing to it. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();
    const tech = await techOwnedBy(userId);
    if (!tech) return fail("forbidden", "tech profile required", 403);

    const [subslot] = await db()
      .select()
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, subslotId));
    if (!subslot) return fail("not_found", "sub-slot not found", 404);
    if (subslot.state !== "open") return fail("conflict", "sub-slot is not open", 409);

    const note = (await req.json().catch(() => ({})))?.note;
    const id = newId("application");
    const d = db();
    const inserted = await d
      .insert(schema.techSubslotApplications)
      .values({ id, subslotId, techId: tech.id, note: typeof note === "string" ? note.slice(0, 1000) : null })
      .onConflictDoNothing()
      .returning({ id: schema.techSubslotApplications.id });
    // Re-apply by the same tech is a no-op insert; don't fabricate a 201 with an
    // id that was never persisted — report the conflict like the slot apply route.
    if (inserted.length === 0)
      return fail("conflict", "you already applied to this sub-slot", 409);
    await appendEvent(d, {
      actor: userId,
      kind: "subslot.application",
      subjectType: "tech_subslot",
      subjectId: subslotId,
      payload: { techId: tech.id, effects: [{ kind: "notify", template: "new_application", to: "payer" }] },
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}

/** A tech may withdraw while their application is still pending. */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();
    const tech = await techOwnedBy(userId);
    if (!tech) return fail("forbidden", "tech profile required", 403);

    const d = db();
    const [application] = await d
      .select()
      .from(schema.techSubslotApplications)
      .where(and(
        eq(schema.techSubslotApplications.subslotId, subslotId),
        eq(schema.techSubslotApplications.techId, tech.id),
      ));
    if (!application) return fail("not_found", "application not found", 404);
    if (application.status !== "submitted")
      return fail("conflict", "only a pending application can be withdrawn", 409);

    await d
      .delete(schema.techSubslotApplications)
      .where(eq(schema.techSubslotApplications.id, application.id));
    await appendEvent(d, {
      actor: userId,
      kind: "subslot.application_withdrawn",
      subjectType: "tech_subslot",
      subjectId: subslotId,
      payload: { techId: tech.id },
    });
    return ok({ withdrawn: true });
  } catch (e) {
    return respondError(e);
  }
}
