import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { reconcileOnce } from "./index.js";

/**
 * The reconcile sweep is the last line of defence for anything the outbox lost:
 * it re-derives overdue work from booking state alone. It used to live only
 * inside a `while (!stopping)` loop with a 10-minute sleep, so none of it —
 * including the 24h payment timeout that unwedges `confirming` — could be
 * tested at all.
 */
describe("reconcile sweep", () => {
  const userV = newId("user");
  const userP = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let seq = 0;

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: userV, email: `${userV}@t.test` },
      { id: userP, email: `${userP}@t.test` },
    ]);
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId, ownerUserId: userV, kind: "bar", name: "Reconcile Bar",
      metro: "reconcile-tv", lat: 43, lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId, ownerUserId: userP, kind: "band",
      name: "Reconcile Band", homeMetro: "reconcile-tv",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  /** A booking parked directly in a given state, with chosen timestamps. */
  async function parked(opts: {
    state: string;
    acceptedAt?: Date | null;
    createdAt?: Date;
    startsAt?: Date;
    slotStatus?: string;
    endsAt?: Date;
  }) {
    const d = db();
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const startsAt =
      opts.startsAt ?? new Date(Date.now() + (100 + seq++) * 86_400_000);
    const endsAt = opts.endsAt ?? new Date(startsAt.getTime() + 2 * 3_600_000);
    await d.insert(schema.slots).values({
      id: slotId, venueId, metro: "reconcile-tv", startsAt,
      durationMinutes: 120, format: "music", budgetCents: 40_000,
      status: opts.slotStatus ?? "filled",
    });
    await d.insert(schema.bookings).values({
      id: bookingId, slotId, venueId, performerId,
      state: opts.state, offerExpiresAt: startsAt,
      performerAcceptedAt: opts.acceptedAt ?? null,
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    });
    if (opts.createdAt)
      await getPool().query(`update bookings set created_at = $2 where id = $1`, [
        bookingId,
        opts.createdAt,
      ]);
    return { bookingId, slotId };
  }

  const stateOf = async (id: string) =>
    (
      await db()
        .select({ state: schema.bookings.state })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, id))
    )[0]?.state;

  async function sweep() {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      return await reconcileOnce();
    } finally {
      spy.mockRestore();
    }
  }

  it("collapses a `confirming` booking stuck past the payment timeout", async () => {
    // Nothing else leaves `confirming` — no timer, no cancel for either party,
    // no admin override. A dead-lettered dispatch parked bookings here forever.
    const { bookingId, slotId } = await parked({
      state: "confirming",
      acceptedAt: new Date(Date.now() - 25 * 3_600_000),
    });
    await sweep();
    expect(await stateOf(bookingId)).toBe("collapsed");
    const [slot] = await db()
      .select({ status: schema.slots.status })
      .from(schema.slots)
      .where(eq(schema.slots.id, slotId));
    expect(slot!.status).toBe("open"); // and the night goes back on the board
  });

  it("leaves a `confirming` booking that is still inside the window", async () => {
    const { bookingId } = await parked({
      state: "confirming",
      acceptedAt: new Date(Date.now() - 3_600_000),
    });
    await sweep();
    expect(await stateOf(bookingId)).toBe("confirming");
  });

  it("closes a pending payment at downbeat even inside the generic timeout", async () => {
    const { bookingId, slotId } = await parked({
      state: "confirming",
      acceptedAt: new Date(Date.now() - 5 * 60_000),
      startsAt: new Date(Date.now() - 60_000),
      slotStatus: "open",
    });
    await sweep();
    expect(await stateOf(bookingId)).toBe("collapsed");
    const [slot] = await db()
      .select({ status: schema.slots.status })
      .from(schema.slots)
      .where(eq(schema.slots.id, slotId));
    expect(slot?.status).toBe("expired");
  });

  it("still drains a `confirming` booking with no recorded acceptance", async () => {
    // The first cut required performer_accepted_at, so a row missing it — the
    // rows most likely to be broken in the first place — could never be
    // drained by the very sweep that exists to drain them.
    const { bookingId } = await parked({
      state: "confirming",
      acceptedAt: null,
      createdAt: new Date(Date.now() - 30 * 3_600_000),
    });
    await sweep();
    expect(await stateOf(bookingId)).toBe("collapsed");
  });

  it("re-arms a lost gig-end timer and auto-confirms an overdue night", async () => {
    const ended = await parked({
      state: "confirmed",
      endsAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const overdue = await parked({
      state: "awaiting_confirmation",
      endsAt: new Date(Date.now() - 30 * 3_600_000),
    });
    await sweep();
    // GIG_ENDED moves confirmed → awaiting_confirmation
    expect(await stateOf(ended.bookingId)).toBe("awaiting_confirmation");
    // AUTO_CONFIRM_ELAPSED closes out the one already past its window
    expect(await stateOf(overdue.bookingId)).toBe("released");
  });

  it("leaves a night that has not happened yet alone", async () => {
    const { bookingId } = await parked({ state: "confirmed" });
    await sweep();
    expect(await stateOf(bookingId)).toBe("confirmed");
  });
});
