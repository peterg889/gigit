import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as resolvePost } from "./disputes/[id]/resolve/route";
import { POST as adjustPost } from "./bookings/[id]/adjust/route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const post = (
  handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: string,
  body: unknown,
) =>
  handler(
    new Request(`http://test/x/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/**
 * Admin money-adjudication routes (F7.4 / F9.1) were untested glue: the admin
 * gate, the route-level partial-sum guard, the 409/422 error mapping, and the
 * adjustment direction→party fork all moved real ledger value with no coverage
 * (audit testgaps). Lock them.
 */
describe("admin money routes", () => {
  const uAdmin = newId("user");
  const uVenue = newId("user");
  const uBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const AMOUNT = 30_000;

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uAdmin, uVenue, uBand].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.actorRoles).values({ id: newId("role"), userId: uAdmin, kind: "admin" });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Admin Bar",
      metro: "adm-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Admin Band",
      homeMetro: "adm-tv",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  async function confirmedBooking(): Promise<string> {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "adm-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: AMOUNT,
    });
    await d.insert(schema.applications).values({ id: appId, slotId, performerId });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: uVenue,
      terms: {
        amountCents: AMOUNT,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, uBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    return bookingId;
  }

  async function disputedBooking(): Promise<string> {
    const bookingId = await confirmedBooking();
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(
      bookingId,
      { kind: "DISPUTE_OPENED", openedBy: "venue", reason: "did not show" },
      uVenue,
    );
    return bookingId;
  }

  const releases = async (bookingId: string) =>
    db()
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.bookingId, bookingId),
          eq(schema.ledgerEntries.entryType, "release"),
        ),
      );

  describe("dispute resolve", () => {
    it("403 for a non-admin", async () => {
      as(uVenue);
      expect((await post(resolvePost, await disputedBooking(), { kind: "release_full" })).status).toBe(403);
    });

    it("release_full → released with a full release ledger row", async () => {
      const bookingId = await disputedBooking();
      as(uAdmin);
      const res = await post(resolvePost, bookingId, { kind: "release_full" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ state: "released" });
      const r = await releases(bookingId);
      expect(r).toHaveLength(1);
      expect(r[0]!.amountCents).toBe(AMOUNT);
    });

    it("partial that doesn't sum to the booking amount → 422", async () => {
      as(uAdmin);
      const res = await post(resolvePost, await disputedBooking(), {
        kind: "partial",
        releaseCents: 10_000,
        refundCents: 5_000,
      });
      expect(res.status).toBe(422);
    });

    it("resolving a booking that isn't disputed → 409", async () => {
      as(uAdmin);
      const res = await post(resolvePost, await confirmedBooking(), { kind: "release_full" });
      expect(res.status).toBe(409);
    });
  });

  describe("manual adjustment", () => {
    const adjustments = (bookingId: string) =>
      db()
        .select()
        .from(schema.ledgerEntries)
        .where(
          and(
            eq(schema.ledgerEntries.bookingId, bookingId),
            eq(schema.ledgerEntries.entryType, "adjustment"),
          ),
        );

    it("403 for a non-admin; 404 for a missing booking", async () => {
      as(uVenue);
      expect(
        (await post(adjustPost, await confirmedBooking(), {
          direction: "refund_venue",
          amountCents: 5_000,
          reason: "goodwill",
        })).status,
      ).toBe(403);
      as(uAdmin);
      expect(
        (await post(adjustPost, newId("booking"), {
          direction: "refund_venue",
          amountCents: 5_000,
          reason: "goodwill",
        })).status,
      ).toBe(404);
    });

    it("refund_venue credits the venue", async () => {
      const bookingId = await confirmedBooking();
      as(uAdmin);
      expect((await post(adjustPost, bookingId, { direction: "refund_venue", amountCents: 4_000, reason: "partial goodwill" })).status).toBe(200);
      const rows = await adjustments(bookingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.creditParty).toBe(`venue:${venueId}`);
      expect(rows[0]!.amountCents).toBe(4_000);
    });

    it("pay_performer credits the performer", async () => {
      const bookingId = await confirmedBooking();
      as(uAdmin);
      expect((await post(adjustPost, bookingId, { direction: "pay_performer", amountCents: 6_000, reason: "extra set" })).status).toBe(200);
      const rows = await adjustments(bookingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.creditParty).toBe(`performer:${performerId}`);
    });
  });
});
