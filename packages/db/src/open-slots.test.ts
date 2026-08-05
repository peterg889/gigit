import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import {
  OpenSlotStartTimeError,
  createOpenSlot,
} from "./open-slots.js";
import { events, slots } from "./schema.js";
import { makeVenue } from "./test/factories.js";

describe("shared open-slot persistence", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("commits a future slot and its outbox event together", async () => {
    const venue = await makeVenue({ name: "Shared Slot Room" });
    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    const id = await createOpenSlot({
      venueId: venue.id,
      actor: venue.ownerUserId,
      startsAt,
      durationMinutes: 120,
      format: "music",
      genrePrefs: ["jazz"],
      budgetCents: 25_000,
      provides: { pa: true },
      source: "web",
    });

    const [slot] = await db()
      .select({
        startsAt: slots.startsAt,
        status: slots.status,
        source: slots.source,
      })
      .from(slots)
      .where(eq(slots.id, id));
    expect(slot).toEqual({ startsAt, status: "open", source: "web" });

    const outbox = await db()
      .select({ subjectId: events.subjectId })
      .from(events)
      .where(
        and(
          eq(events.kind, "slot.created"),
          eq(events.subjectType, "slot"),
          eq(events.subjectId, id),
        ),
      );
    expect(outbox).toEqual([{ subjectId: id }]);
  });

  it("rejects a stale start at the commit boundary without a slot or event", async () => {
    const venue = await makeVenue({ name: "Stale Shared Slot Room" });
    const startsAt = new Date(Date.now() - 1);

    await expect(
      createOpenSlot({
        venueId: venue.id,
        actor: venue.ownerUserId,
        startsAt,
        durationMinutes: 120,
        format: "music",
        genrePrefs: [],
        budgetCents: 25_000,
        provides: {},
        source: "sms",
      }),
    ).rejects.toBeInstanceOf(OpenSlotStartTimeError);

    const persistedSlots = await db()
      .select({ id: slots.id })
      .from(slots)
      .where(eq(slots.venueId, venue.id));
    expect(persistedSlots).toHaveLength(0);

    const outbox = await db()
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.actor, venue.ownerUserId),
          eq(events.kind, "slot.created"),
        ),
      );
    expect(outbox).toHaveLength(0);
  });
});
