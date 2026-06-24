import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

const slotUpdateSchema = z
  .object({
    budgetCents: z.number().int().min(1).optional(),
    durationMinutes: z.number().int().min(15).max(600).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

type Guard =
  | { ok: false; response: NextResponse }
  | { ok: true; slot: typeof schema.slots.$inferSelect };

/** Owner-guard: the caller's venue owns this slot and it's still 'open'. */
async function ownedOpenSlot(id: string, userId: string): Promise<Guard> {
  const venue = await venueOwnedBy(userId);
  if (!venue)
    return { ok: false, response: fail("forbidden", "venue profile required", 403) };
  const [slot] = await db().select().from(schema.slots).where(eq(schema.slots.id, id));
  if (!slot) return { ok: false, response: fail("not_found", "slot not found", 404) };
  if (slot.venueId !== venue.id)
    return { ok: false, response: fail("forbidden", "not your slot", 403) };
  if (slot.status !== "open")
    return { ok: false, response: fail("conflict", `slot is ${slot.status}`, 409) };
  return { ok: true, slot };
}

/** Edit an open slot's terms (PRD F2.1 — slot management). */
export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const r = await ownedOpenSlot(id, userId);
    if (!r.ok) return r.response;
    const parsed = await parseBody(req, slotUpdateSchema);
    if ("response" in parsed) return parsed.response;
    const d = db();
    await d.update(schema.slots).set(parsed.data).where(eq(schema.slots.id, id));
    await appendEvent(d, {
      actor: userId,
      kind: "slot.updated",
      subjectType: "slot",
      subjectId: id,
      payload: { fields: Object.keys(parsed.data) },
    });
    return ok({ id });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}

/** Close an open slot — takes it off the board (the only way to cancel a standalone slot). */
export async function DELETE(_req: Request, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const r = await ownedOpenSlot(id, userId);
    if (!r.ok) return r.response;
    const d = db();
    await d.update(schema.slots).set({ status: "cancelled" }).where(eq(schema.slots.id, id));
    await appendEvent(d, {
      actor: userId,
      kind: "slot.cancelled",
      subjectType: "slot",
      subjectId: id,
    });
    return ok({ id, status: "cancelled" });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
