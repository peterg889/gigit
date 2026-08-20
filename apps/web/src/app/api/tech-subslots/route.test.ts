import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, makePerformer, makeTech, makeVenue, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";

import { GET } from "./route";

/**
 * `GET /api/tech-subslots` is UNAUTHENTICATED and returns the venue's name and
 * full street address alongside the act's name and the pay. That data is public
 * by design — /techs renders it to anonymous visitors and the privacy notice
 * says so — but only for jobs that are still real: a confirmed booking, in the
 * future, on profiles and accounts that are all still active.
 *
 * The page enforced six conditions. This route enforced one (`state = 'open'`),
 * so it published sound jobs for cancelled bookings and gigs that had already
 * happened, and it kept naming venues and acts after they were hidden,
 * suspended or deleted. Suspension is the only moderation lever the product
 * has; an endpoint that keeps serving a suspended venue's address defeats it.
 *
 * Each case below seeds ONE ineligible job and asserts it is absent while an
 * eligible control is present — so a test cannot pass merely because the feed
 * came back empty.
 */
describe("the open sound-job feed excludes what the page excludes", () => {
  const marker = `feedgate-${Date.now()}`;
  const created: { subslots: string[]; bookings: string[]; slots: string[] } = {
    subslots: [],
    bookings: [],
    slots: [],
  };

  /** One sound job, with every eligibility axis independently controllable. */
  async function soundJob(
    label: string,
    opts: {
      bookingState?: string;
      startsAt?: Date;
      venueStatus?: string;
      performerStatus?: string;
      venueOwnerStatus?: string;
      performerOwnerStatus?: string;
      subslotState?: string;
    } = {},
  ) {
    const venue = await makeVenue({
      name: `${marker} ${label} VENUE`,
      ...(opts.venueStatus ? { status: opts.venueStatus } : {}),
    });
    const performer = await makePerformer({
      name: `${marker} ${label} ACT`,
      ...(opts.performerStatus ? { status: opts.performerStatus } : {}),
    });
    for (const [owner, status] of [
      [venue.ownerUserId, opts.venueOwnerStatus],
      [performer.ownerUserId, opts.performerOwnerStatus],
    ] as const)
      if (status)
        await db().update(schema.users).set({ status }).where(eq(schema.users.id, owner));

    // Minutes away, not weeks. The feed caps at 100 ordered by downbeat, and a
    // long-lived dev database holds far more than 100 open jobs — a fixture
    // three weeks out never appears, and the absence assertions below would
    // then pass for the wrong reason. apps/web/src/app/techs/page.test.tsx
    // documents the same trap.
    const startsAt = opts.startsAt ?? new Date(Date.now() + 5 * 60_000);
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const subslotId = newId("slot");
    created.slots.push(slotId);
    created.bookings.push(bookingId);
    created.subslots.push(subslotId);

    await db().insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "feed-gate-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      venueId: venue.id,
      performerId: performer.id,
      state: opts.bookingState ?? "confirmed",
      offerExpiresAt: startsAt,
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await db().insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      state: opts.subslotState ?? "open",
    });
    return { venueName: `${marker} ${label} VENUE` };
  }

  beforeAll(async () => {
    await makeTech({ name: `${marker} onlooker` });
  });

  afterAll(async () => {
    const d = db();
    await d.delete(schema.techSubslots).where(inArray(schema.techSubslots.id, created.subslots));
    await d.delete(schema.bookings).where(inArray(schema.bookings.id, created.bookings));
    await d.delete(schema.slots).where(inArray(schema.slots.id, created.slots));
    await closeDb();
  });

  const feed = async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    return JSON.stringify(await res.json());
  };

  it("lists a job whose booking, room and act are all still live", async () => {
    const { venueName } = await soundJob("ELIGIBLE");
    expect(await feed()).toContain(venueName);
  });

  it.each([
    ["a booking the venue cancelled", { bookingState: "cancelled_by_venue" }],
    ["a booking that never confirmed", { bookingState: "offered" }],
    ["a night that already happened", { startsAt: new Date(Date.now() - 86_400_000) }],
    ["a room that was hidden or deactivated", { venueStatus: "hidden" }],
    ["an act suspended by ops", { performerStatus: "suspended" }],
    ["a venue owner who is no longer active", { venueOwnerStatus: "suspended" }],
    ["an act owner who is no longer active", { performerOwnerStatus: "deleted" }],
    // The consent gate leans on this filter rather than adding one of its own:
    // a job in `awaiting_payer` names a payer who has not agreed to fund it, so
    // publishing it would invite techs to apply for a bill that may never
    // exist. `state = 'open'` already excludes it — this asserts that instead
    // of assuming it, because a feed that widened to "any active state" would
    // do exactly the wrong thing.
    [
      "a sound job nobody has agreed to pay for yet",
      { subslotState: "awaiting_payer" },
    ],
  ])("does not publish %s", async (label, opts) => {
    const { venueName } = await soundJob(
      label.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 12),
      opts,
    );
    const body = await feed();
    expect(body).not.toContain(venueName);
    // The eligible control from the first case is still there, so this did not
    // pass merely because the feed came back empty.
    expect(body).toContain(`${marker} ELIGIBLE VENUE`);
  });
});
