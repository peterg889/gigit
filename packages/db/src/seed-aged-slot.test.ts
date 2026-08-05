import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import {
  applications,
  performers,
  slots,
  users,
  venues,
} from "./schema.js";
import { ensureAgedSlotE2EJourneys } from "./seed-aged-slot.js";
import { E2E_JOURNEYS } from "./seed-fixtures.js";

describe("aged-slot E2E seed", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("is deterministic, retry-safe, idempotent, and restores reconciled rows", async () => {
    const now = new Date("2030-06-15T12:00:00.000Z");
    const first = await ensureAgedSlotE2EJourneys(db(), now);
    const second = await ensureAgedSlotE2EJourneys(db(), now);
    expect(second).toEqual(first);
    expect(first).toHaveLength(E2E_JOURNEYS.aged.attempts.length);

    const emails = E2E_JOURNEYS.aged.attempts.flatMap(({ venue, performer }) =>
      [venue.email, performer.email],
    );
    expect(
      await db()
        .select({ email: users.email, status: users.status })
        .from(users)
        .where(inArray(users.email, emails)),
    ).toHaveLength(4);

    for (const [index, ids] of first.entries()) {
      const fixture = E2E_JOURNEYS.aged.attempts[index]!;
      expect(ids.slotId).toBe(fixture.slot.id);
      expect(ids.applicationId).toBe(fixture.slot.applicationId);
      expect(
        await db()
          .select({ status: venues.status })
          .from(venues)
          .where(eq(venues.id, ids.venueId)),
      ).toEqual([{ status: "live" }]);
      expect(
        await db()
          .select({ status: performers.status })
          .from(performers)
          .where(eq(performers.id, ids.performerId)),
      ).toEqual([{ status: "live" }]);
      const [slot] = await db()
        .select({
          notes: slots.notes,
          startsAt: slots.startsAt,
          status: slots.status,
        })
        .from(slots)
        .where(eq(slots.id, ids.slotId));
      expect(slot).toMatchObject({
        notes: fixture.slot.marker,
        status: "open",
      });
      expect(slot!.startsAt.toISOString()).toBe(
        new Date(now.getTime() - (24 + index) * 3_600_000).toISOString(),
      );
      expect(
        await db()
          .select({
            note: applications.note,
            status: applications.status,
            declineReason: applications.declineReason,
          })
          .from(applications)
          .where(eq(applications.id, ids.applicationId)),
      ).toEqual([
        {
          note: fixture.slot.applicationNote,
          status: "submitted",
          declineReason: null,
        },
      ]);
    }

    const mutated = first[0]!;
    await db()
      .update(slots)
      .set({ status: "expired" })
      .where(eq(slots.id, mutated.slotId));
    await db()
      .update(applications)
      .set({ status: "declined", declineReason: "slot_expired" })
      .where(eq(applications.id, mutated.applicationId));

    expect(await ensureAgedSlotE2EJourneys(db(), now)).toEqual(first);
    expect(
      await db()
        .select({ status: slots.status })
        .from(slots)
        .where(eq(slots.id, mutated.slotId)),
    ).toEqual([{ status: "open" }]);
    expect(
      await db()
        .select({
          status: applications.status,
          declineReason: applications.declineReason,
        })
        .from(applications)
        .where(eq(applications.id, mutated.applicationId)),
    ).toEqual([{ status: "submitted", declineReason: null }]);
  });
});
