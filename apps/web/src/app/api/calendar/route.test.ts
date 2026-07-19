import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { GET, POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);

/** iCal feed (F3.6): signed token in, confirmed bookings out — never drafts. */
describe("calendar feed", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let confirmedBookingId: string;

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uVenue, uBand].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Calendar Bar",
      metro: "cal-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Calendar Band",
      homeMetro: "cal-tv",
    });
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + 30 * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "cal-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 15_000,
    });
    await d.insert(schema.applications).values({ id: appId, slotId, performerId });
    confirmedBookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: uVenue,
      terms: {
        amountCents: 15_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(confirmedBookingId, { kind: "PERFORMER_ACCEPTED" }, uBand);
    await runBookingTransition(confirmedBookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("mints a personal feed URL and serves the confirmed booking as an event", async () => {
    as(uBand);
    const minted = await POST();
    expect(minted.status).toBe(200);
    const { url } = await minted.json();
    const token = new URL(url).searchParams.get("token")!;
    expect(token).toBeTruthy();

    const res = await GET(new Request(`http://test/api/calendar?token=${token}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain(`UID:${confirmedBookingId}@gigit`);
    expect(body).toContain("Calendar Band at Calendar Bar");
  });

  it("rejects missing or forged tokens", async () => {
    expect((await GET(new Request("http://test/api/calendar"))).status).toBe(401);
    expect(
      (await GET(new Request("http://test/api/calendar?token=ey.forged.token"))).status,
    ).toBe(401);
  });
});
