import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makePerformer, makeVenue, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as createSlot } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const post = (body: unknown) =>
  createSlot(
    new Request("http://test/api/slots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * Posting a slot, which had no test at all — and could not easily have one.
 *
 * The route gates on `venueLocationIsComplete`, and every venue fixture in the
 * suite omitted `timeZone`, so every venue was UTC, which that function treats as
 * the legacy-migration fallback rather than a real answer. So a test written
 * against a hand-rolled fixture got a 409 and the natural move was to "fix" the
 * assertion instead of the fixture. `makeVenue()` defaults to a complete Chicago
 * room, which makes the realistic path the easy one to test.
 */
describe("posting an open date", () => {
  afterAll(async () => {
    await closeDb();
  });

  const nextMonth = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

  it("creates an open slot for a complete venue", async () => {
    const venue = await makeVenue({ name: "Create Room" });
    as(venue.ownerUserId);
    const res = await post({
      startsAt: nextMonth(),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      provides: { pa: true },
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const [slot] = await db()
      .select()
      .from(schema.slots)
      .where(eq(schema.slots.id, id));
    expect(slot!.status).toBe("open");
    expect(slot!.budgetCents).toBe(30_000);
    // The metro is copied from the venue and stored lowercased, which is what
    // the feed filter and the saved-search matcher both compare against.
    expect(slot!.metro).toBe(slot!.metro.toLowerCase());
  });

  it("refuses a venue with no address or timezone, and says why", async () => {
    // The condition this gate exists for: you cannot schedule a night in a room
    // whose local time you don't know.
    const venue = await makeVenue({
      name: "Incomplete Room",
      addressLine1: "",
      timeZone: "UTC",
    });
    as(venue.ownerUserId);
    const res = await post({
      startsAt: nextMonth(),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.message).toMatch(/address/i);
  });

  it("refuses a date in the past", async () => {
    const venue = await makeVenue({ name: "Past Room" });
    as(venue.ownerUserId);
    const res = await post({
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    expect(res.status).toBe(422);
  });

  it("refuses a caller with no venue profile", async () => {
    const act = await makePerformer({ name: "Not A Venue" });
    as(act.ownerUserId);
    const res = await post({
      startsAt: nextMonth(),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    expect(res.status).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    as(null);
    expect((await post({})).status).toBe(401);
  });
});
