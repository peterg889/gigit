import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthError, performerOwnedBy, requireUser, venueOwnedBy } from "@/lib/auth";
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

    const d = db();
    const [row] = await d
      .select({ application: schema.applications, slot: schema.slots })
      .from(schema.applications)
      .innerJoin(schema.slots, eq(schema.applications.slotId, schema.slots.id))
      .where(eq(schema.applications.id, id));
    if (!row) return fail("not_found", "application not found", 404);
    if (row.application.status !== "submitted")
      return fail("conflict", `application is ${row.application.status}`, 409);

    if (parsed.data.action === "decline") {
      const venue = await venueOwnedBy(userId);
      if (!venue || venue.id !== row.slot.venueId)
        return fail("forbidden", "not your slot", 403);
    } else {
      const performer = await performerOwnedBy(userId);
      if (!performer || performer.id !== row.application.performerId)
        return fail("forbidden", "not your application", 403);
    }

    const status = parsed.data.action === "decline" ? "declined" : "withdrawn";
    await d
      .update(schema.applications)
      .set({ status })
      .where(eq(schema.applications.id, id));
    await appendEvent(d, {
      actor: userId,
      kind: `application.${status}`,
      subjectType: "slot",
      subjectId: row.slot.id,
      payload: { applicationId: id },
    });
    return ok({ status });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
