import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import {
  closeDb,
  createOffer,
  db,
  deactivateAccount,
  runBookingTransition,
  schema,
  suspendAccount,
} from "@gigit/db";

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
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
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

  /**
   * The reason assertAccountActive exists as its own function (auth.ts): the
   * feed token is good for 365 days and there is no revocation short of
   * rotating SESSION_SECRET, so moderating an account has to bite on the NEXT
   * fetch of a token minted before it. Each event carries the venue's street
   * address and the pay, so a feed that keeps serving after a suspension is a
   * data leak, not a stale calendar.
   *
   * These two run last in the file: both mutate account status for good, and
   * suspension winds the confirmed booking down with it.
   */
  const mint = async (uid: string) => {
    as(uid);
    const minted = await POST();
    expect(minted.status).toBe(200);
    const { url } = await minted.json();
    return `http://test/api/calendar?token=${new URL(url).searchParams.get("token")}`;
  };

  it("stops serving a suspended account's feed while other accounts keep theirs", async () => {
    // Both tokens are minted BEFORE any status change: the token has to keep
    // working until its own account is moderated, which is what makes the
    // re-check on every fetch the only lever there is.
    const bandFeed = await mint(uBand);
    const venueFeed = await mint(uVenue);
    const before = await GET(new Request(bandFeed));
    expect(before.status).toBe(200);
    const leaked = await before.text();
    expect(leaked).toContain("1 Test St");
    expect(leaked).toContain("$150 — booked on EightGig");

    expect(await suspendAccount(uBand, "usr_admin_calendar")).toBe("updated");

    const after = await GET(new Request(bandFeed));
    expect(after.status).toBe(403);
    expect(await after.clone().json()).toMatchObject({
      error: { message: "This account is suspended. Contact support." },
    });
    // Belt and braces: a 403 that still shipped the ICS body would leak the
    // address anyway.
    expect(await after.text()).not.toContain("1 Test St");

    // The gate is per-account, not a blanket failure — the venue's own feed
    // for the same booking is untouched by the act's suspension.
    expect((await GET(new Request(venueFeed))).status).toBe(200);
  });

  it("stops serving a deactivated account's feed", async () => {
    const venueFeed = await mint(uVenue);
    expect((await GET(new Request(venueFeed))).status).toBe(200);

    await deactivateAccount(uVenue);

    const after = await GET(new Request(venueFeed));
    expect(after.status).toBe(403);
    expect(await after.clone().json()).toMatchObject({
      error: { message: "This account has been deactivated." },
    });
    expect(await after.text()).not.toContain("1 Test St");
  });
});
