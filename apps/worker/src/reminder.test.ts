import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";

/**
 * The day-before reminder (PRD F5.2, journey O4).
 *
 * The job is armed the moment a booking confirms and fires up to weeks later,
 * so between arming and firing the booking can be cancelled, disputed, or
 * collapsed back to the board — and the queue has no way to know. The handler's
 * `state !== 'confirmed'` re-read is the ONLY thing standing between a
 * cancelled gig and a "Gig tomorrow" text to both parties on a night neither of
 * them is playing. Nothing exercised that branch: the handler is registered
 * inside `main()`, so no test had ever called it at all.
 *
 * The handler is an inline closure, so the seam is the boss: fake pg-boss,
 * capture what `work()` was handed, and invoke the reminder handler directly
 * with the job pg-boss would deliver.
 */
const registered = vi.hoisted(
  () => new Map<string, (jobs: unknown[]) => Promise<void>>(),
);
vi.mock("pg-boss", () => {
  class FakePgBoss {
    on() {}
    async start() {}
    async createQueue() {}
    async work(name: string, handler: (jobs: unknown[]) => Promise<void>) {
      registered.set(name, handler);
    }
    async schedule() {}
    async send() {
      return null;
    }
    async stop() {}
  }
  return { default: FakePgBoss };
});

// The three fire-and-forget boot self-heals sweep rows this file never created
// (every active series, every past-dated open slot, every venue's night facts).
// They are covered in packages/db and in boot.test.ts; here they would only
// churn other suites' fixtures while this file waits on a booking of its own.
vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    snapshotNightFacts: async () => 0,
    materializeAllActiveSeries: async () => 0,
    expirePastSlots: async () => 0,
  };
});

const { closeDb, db, getPool, schema } = await import("@gigit/db");
const { main } = await import("./index.js");

type Sink = { kind: string; userId?: string; template?: string; bookingId?: string };

/** Run `fn` with console.log captured, and return the structured lines it wrote. */
async function captureLog(fn: () => Promise<void>): Promise<Sink[]> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  let calls: unknown[][] = [];
  try {
    await fn();
  } finally {
    // Copy before restoring: mockRestore drops the recorded calls with the spy,
    // so reading them afterwards yields an empty (silently passing) list.
    calls = spy.mock.calls.slice();
    spy.mockRestore();
  }
  return calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Sink;
      } catch {
        return null;
      }
    })
    .filter((x): x is Sink => x !== null);
}

describe("day-before reminder handler", () => {
  const venueOwner = newId("user");
  const performerOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const confirmedBooking = newId("booking");
  const cancelledBooking = newId("booking");

  /** A booking on a future night, in whatever state the caller wants to test. */
  async function seedBooking(bookingId: string, state: string) {
    const startsAt = new Date(Date.now() + 2 * 86_400_000);
    const slotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "reminder-tv",
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
      state,
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
      name: "Reminder Room",
      metro: "reminder-tv",
      lat: 43,
      lng: -88,
      addressLine1: "1 Reminder St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwner,
      kind: "band",
      name: "Reminder Band",
      homeMetro: "reminder-tv",
    });
    await seedBooking(confirmedBooking, "confirmed");
    // Cancelled hours after the reminder was armed — the case that ships today.
    await seedBooking(cancelledBooking, "cancelled_by_venue");

    // main() starts a real drain loop against the shared database. Retire the
    // backlog first (as boot.test.ts does) so it cannot fire another suite's
    // effects into the log lines this file reads.
    await getPool().query(
      `update events set dispatched_at = now()
        where dispatched_at is null and dead_lettered_at is null`,
    );
    const booted = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    booted.mockRestore();
  });

  afterAll(async () => {
    // main() installs the real SIGTERM shutdown; use it (the only way to set
    // `stopping` and unwind the loops) with process.exit stubbed out.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    exit.mockRestore();
    await closeDb();
  });

  /** Deliver one reminder job exactly as pg-boss would. */
  const fireReminder = async (bookingId: string) => {
    const handler = registered.get("booking-reminders");
    expect(handler, "no worker registered for booking-reminders").toBeDefined();
    return captureLog(() => handler!([{ data: { bookingId } }]));
  };

  it("says nothing to anyone about a booking that is no longer confirmed", async () => {
    const lines = await fireReminder(cancelledBooking);

    // With no Twilio/SES configured, every real send lands as a
    // `notify.log_sink` line — so zero of them is the assertion that nothing
    // went out. Not "no day_before line": ANY delivery here is a message about
    // a gig that isn't happening.
    expect(lines.filter((l) => l.kind === "notify.log_sink")).toEqual([]);
    // And it has to be visibly a decision, not a silent drop: `reminder.stale`
    // is how an operator tells "the reminder was suppressed" apart from "the
    // reminder queue is broken".
    expect(lines).toContainEqual(
      expect.objectContaining({
        kind: "reminder.stale",
        bookingId: cancelledBooking,
      }),
    );
    expect(lines.some((l) => l.kind === "reminder.sent")).toBe(false);
  });

  it("still reminds both parties about a booking that is still confirmed", async () => {
    // The positive control: without it, a handler that suppressed EVERY
    // reminder would pass the test above and the feature would be gone.
    const lines = await fireReminder(confirmedBooking);

    const sinks = lines.filter((l) => l.kind === "notify.log_sink");
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: venueOwner, template: "day_before" }),
    );
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: performerOwner, template: "day_before" }),
    );
    expect(sinks).toHaveLength(2);
    expect(lines).toContainEqual(
      expect.objectContaining({
        kind: "reminder.sent",
        bookingId: confirmedBooking,
      }),
    );
  });
});
