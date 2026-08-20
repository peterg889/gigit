import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PgBoss from "pg-boss";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { drainOutboxOnce } from "./index.js";

/**
 * Arming the day-before reminder (PRD F5.2, journey O4).
 *
 * The arm lives in the outbox fan-out, not the domain reducer, so the seam is a
 * boss handed to `drainOutboxOnce` — and this file hands it a REAL pg-boss
 * against the test database rather than a stub that records `send` calls. A
 * stub proves the arguments were computed; only the queue proves a job exists,
 * that its `start_after` is the night before the gig, and that one confirmation
 * produced one job. Every assertion here is read back out of `pgboss.job`.
 *
 * KNOWN GAP, deliberately not asserted below: `singletonKey` does NOT dedup on
 * this queue. pg-boss 10.4.2 enforces singleton keys through partial unique
 * indexes gated on the queue policy (`job_i1` … `job_i4` in its plans.js), and
 * `createQueue(REMINDER_QUEUE)` takes the default `standard` policy, which
 * matches none of them. Two sends with the same key insert two jobs. So the
 * at-least-once outbox re-delivering one `booking.transition` → `confirmed`
 * row arms a second reminder and both fire. Asserting "exactly one job after a
 * re-delivery" would fail against today's code; it is reported as a product
 * finding instead. What IS asserted is that the key reaches the job row, so the
 * intent cannot silently disappear before the policy is fixed.
 */
describe("day-before reminder arming", () => {
  const venueOwner = newId("user");
  const performerOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const farBooking = newId("booking");
  const closeBooking = newId("booking");
  const farStartsAt = new Date(Date.now() + 7 * 86_400_000);
  const closeStartsAt = new Date(Date.now() + 6 * 3_600_000);

  let boss: PgBoss;

  async function seedBooking(bookingId: string, startsAt: Date) {
    const slotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "arming-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      venueId,
      performerId,
      state: "confirmed",
      offerExpiresAt: startsAt,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
  }

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: venueOwner, email: `${venueOwner}@t.test` },
      { id: performerOwner, email: `${performerOwner}@t.test` },
    ]);
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwner,
      kind: "bar",
      name: "Arming Room",
      metro: "arming-tv",
      lat: 43,
      lng: -88,
      addressLine1: "1 Arming St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwner,
      kind: "band",
      name: "Arming Band",
      homeMetro: "arming-tv",
    });
    await seedBooking(farBooking, farStartsAt);
    await seedBooking(closeBooking, closeStartsAt);

    boss = new PgBoss(process.env.DATABASE_URL!);
    boss.on("error", () => {});
    await boss.start();
    // The worker creates this queue in main(); without it every send would be
    // dropped on the floor (the insert joins pgboss.queue) and the absence
    // assertion below would pass for the wrong reason.
    await boss.createQueue("booking-reminders");
  });

  afterAll(async () => {
    await getPool().query(
      `delete from pgboss.job where name = 'booking-reminders' and data->>'bookingId' = any($1)`,
      [[farBooking, closeBooking]],
    );
    await boss.stop({ graceful: false });
    await closeDb();
  });

  /** Park the backlog, inject one confirmed transition, drain it. */
  async function confirm(bookingId: string) {
    await getPool().query(
      `update events set dispatched_at = now()
        where dispatched_at is null and dead_lettered_at is null`,
    );
    await getPool().query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('worker','booking.transition','booking',$1,$2::jsonb)`,
      [bookingId, JSON.stringify({ to: "confirmed", effects: [] })],
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await drainOutboxOnce(boss);
    } finally {
      spy.mockRestore();
    }
  }

  const queuedFor = async (bookingId: string) =>
    (
      await getPool().query(
        `select start_after, singleton_key, data
           from pgboss.job
          where name = 'booking-reminders' and data->>'bookingId' = $1`,
        [bookingId],
      )
    ).rows as { start_after: Date; singleton_key: string | null; data: unknown }[];

  it("queues one reminder for the night before the gig when a booking confirms", async () => {
    await confirm(farBooking);
    const jobs = await queuedFor(farBooking);

    // One confirmation, one reminder: zero means the act and the venue get no
    // day-before at all, and more than one means the same night is texted twice.
    expect(jobs).toHaveLength(1);
    // 24h before downbeat to the second. An offset computed off the wrong field
    // (endsAt, offerExpiresAt) or in the wrong unit still produces a plausible
    // future date, so this is pinned rather than bounded.
    expect(jobs[0]!.start_after.getTime()).toBe(farStartsAt.getTime() - 86_400_000);
    expect(jobs[0]!.singleton_key).toBe(`${farBooking}:day_before`);
    expect(jobs[0]!.data).toEqual({ bookingId: farBooking });
  });

  it("arms nothing for a booking confirmed less than a day before downbeat", async () => {
    await confirm(closeBooking);

    // `remindAt > Date.now()` is the guard. Without it a same-week booking
    // confirmed six hours before the gig queues a job whose start_after is in
    // the past, which pg-boss runs immediately — so the "Gig tomorrow" text
    // arrives during load-in, on the day of the show.
    expect(await queuedFor(closeBooking)).toHaveLength(0);
  });
});
