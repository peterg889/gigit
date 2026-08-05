import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenSlotStartTimeError,
  closeDb,
  db,
  makePerformer,
  makeUser,
  makeVenue,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";

const openSlotBoundary = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@gigit/db", async (original) => {
  const actual = await original<typeof import("@gigit/db")>();
  return {
    ...actual,
    createOpenSlot: async (...args: Parameters<typeof actual.createOpenSlot>) => {
      if (openSlotBoundary.error) throw openSlotBoundary.error;
      return actual.createOpenSlot(...args);
    },
  };
});

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as createSlot } from "./route";
import { POST as createVenue } from "../venues/route";

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
  afterEach(() => {
    openSlotBoundary.error = null;
  });
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

  it("returns a clean conflict when the date passes at the persistence boundary", async () => {
    const venue = await makeVenue({ name: "Boundary Room" });
    as(venue.ownerUserId);
    openSlotBoundary.error = new OpenSlotStartTimeError(new Date());

    const res = await post({
      startsAt: nextMonth(),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: "slot_not_future",
        message: expect.stringMatching(/future date/i),
      },
    });
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

/**
 * A venue used to be asked for its city twice — "City" and "City or metro area",
 * both required, separated by ZIP CODE. The metro is derived from the city now,
 * and stays overridable so a suburb room can be listed in the Milwaukee scene.
 */
describe("venue metro derivation", () => {
  const create = (body: unknown) =>
    createVenue(
      new Request("http://test/api/venues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const baseVenue = {
    kind: "bar",
    addressLine1: "12 Derive St",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
  };

  it("derives the metro from the city, normalized the way the feed matches it", async () => {
    const owner = await makeUser();
    as(owner);
    const res = await create({ ...baseVenue, name: "Derived Room", city: "Wauwatosa" });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const [v] = await db()
      .select({ metro: schema.venues.metro })
      .from(schema.venues)
      .where(eq(schema.venues.id, id));
    // lowercased, because that is what the feed filter and the alert matcher compare
    expect(v!.metro).toBe("wauwatosa");
  });

  it("still lets a venue name a different scene than its city", async () => {
    const owner = await makeUser();
    as(owner);
    const res = await create({
      ...baseVenue,
      name: "Suburb Room",
      city: "Wauwatosa",
      metro: "Milwaukee",
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const [v] = await db()
      .select({ metro: schema.venues.metro, city: schema.venues.city })
      .from(schema.venues)
      .where(eq(schema.venues.id, id));
    expect(v).toEqual({ metro: "milwaukee", city: "Wauwatosa" });
  });
});
