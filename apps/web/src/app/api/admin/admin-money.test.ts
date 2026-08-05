import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";

const paymentMode = vi.hoisted(() => ({ enabled: true }));
vi.mock("@gigit/db", async (original) => ({
  ...(await original<typeof import("@gigit/db")>()),
  paymentsEnabled: () => paymentMode.enabled,
}));

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
  let bookingSequence = 0;
  let adjustmentSequence = 0;

  beforeEach(() => {
    paymentMode.enabled = true;
  });

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uAdmin, uVenue, uBand].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.actorRoles).values({ id: newId("role"), userId: uAdmin, kind: "admin" });
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
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

  async function offeredBooking(): Promise<string> {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + (3 + bookingSequence++) * 86_400_000);
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
    return bookingId;
  }

  async function confirmedBooking(): Promise<string> {
    const bookingId = await offeredBooking();
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, uBand);
    await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_SUCCEEDED", paymentRef: `pi_admin_${bookingId}` },
      "worker",
    );
    return bookingId;
  }

  async function settledBooking(): Promise<string> {
    const bookingId = await confirmedBooking();
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(bookingId, { kind: "VENUE_CONFIRMED" }, uVenue);
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

    it.each([
      [0, AMOUNT],
      [AMOUNT, 0],
    ])(
      "zero-leg partial resolution (%i release / %i refund) → 422",
      async (releaseCents, refundCents) => {
        as(uAdmin);
        const res = await post(resolvePost, await disputedBooking(), {
          kind: "partial",
          releaseCents,
          refundCents,
        });
        expect(res.status).toBe(422);
      },
    );

    it("resolving a booking that isn't disputed → 409", async () => {
      as(uAdmin);
      const res = await post(resolvePost, await confirmedBooking(), { kind: "release_full" });
      expect(res.status).toBe(409);
    });
  });

  describe("manual adjustment", () => {
    const adjustmentBody = (
      overrides: Partial<{
        direction: "refund_venue" | "pay_performer";
        amountCents: number;
        reason: string;
        idempotencyKey: string;
      }> = {},
    ) => ({
      direction: "refund_venue" as const,
      amountCents: 5_000,
      reason: "goodwill correction",
      idempotencyKey: `adjustment-request-${++adjustmentSequence}`,
      ...overrides,
    });

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
    const adjustmentEvents = (bookingId: string) =>
      db()
        .select()
        .from(schema.events)
        .where(
          and(
            eq(schema.events.subjectId, bookingId),
            eq(schema.events.kind, "booking.adjustment"),
          ),
        );

    it("403 for a non-admin; 404 for a missing booking", async () => {
      as(uVenue);
      expect(
        (await post(adjustPost, await confirmedBooking(), adjustmentBody())).status,
      ).toBe(403);
      as(uAdmin);
      expect(
        (await post(adjustPost, newId("booking"), adjustmentBody())).status,
      ).toBe(404);
    });

    it("rejects adjustments while platform payments are disabled", async () => {
      const bookingId = await confirmedBooking();
      paymentMode.enabled = false;
      as(uAdmin);

      const response = await post(adjustPost, bookingId, adjustmentBody());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "payments_disabled" },
      });
      expect(await adjustments(bookingId)).toHaveLength(0);
      expect(await adjustmentEvents(bookingId)).toHaveLength(0);
    });

    it("rejects a booking with no durable parent charge", async () => {
      const bookingId = await offeredBooking();
      as(uAdmin);

      const response = await post(adjustPost, bookingId, adjustmentBody());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "booking_not_charged" },
      });
      expect(await adjustments(bookingId)).toHaveLength(0);
      expect(await adjustmentEvents(bookingId)).toHaveLength(0);
    });

    it.each([
      ["a blank reason", { reason: "     " }],
      ["an amount beyond the ledger integer limit", { amountCents: 2_147_483_648 }],
    ])("rejects %s before writing money intent", async (_label, overrides) => {
      const bookingId = await settledBooking();
      as(uAdmin);

      const response = await post(
        adjustPost,
        bookingId,
        adjustmentBody(overrides),
      );
      expect(response.status).toBe(422);
      expect(await adjustments(bookingId)).toHaveLength(0);
      expect(await adjustmentEvents(bookingId)).toHaveLength(0);
    });

    it("does not mistake a sound-subslot charge for refundable parent principal", async () => {
      const bookingId = await settledBooking();
      await db().insert(schema.ledgerEntries).values({
        bookingId,
        entryType: "charge",
        debitParty: `venue:${venueId}`,
        creditParty: "platform",
        amountCents: 10_000,
        idempotencyKey: `${newId("slot")}:charge:0`,
      });
      as(uAdmin);

      const response = await post(
        adjustPost,
        bookingId,
        adjustmentBody({ amountCents: AMOUNT + 1 }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "refund_exceeds_charge" },
      });
      expect(await adjustments(bookingId)).toHaveLength(0);
    });

    it("rejects venue refunds while lifecycle settlement remains pending", async () => {
      const bookingIds = [await confirmedBooking(), await disputedBooking()];
      as(uAdmin);

      for (const bookingId of bookingIds) {
        const response = await post(
          adjustPost,
          bookingId,
          adjustmentBody({
            amountCents: 4_000,
            reason: "premature venue refund",
          }),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { code: "refund_not_settled" },
        });
        expect(await adjustments(bookingId)).toHaveLength(0);
        expect(await adjustmentEvents(bookingId)).toHaveLength(0);
      }
    });

    it("refund_venue credits the venue", async () => {
      const bookingId = await settledBooking();
      const body = adjustmentBody({
        amountCents: 4_000,
        reason: "partial goodwill",
      });
      as(uAdmin);
      expect((await post(adjustPost, bookingId, body)).status).toBe(200);
      const rows = await adjustments(bookingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.creditParty).toBe(`venue:${venueId}`);
      expect(rows[0]!.amountCents).toBe(4_000);
      const events = await adjustmentEvents(bookingId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        direction: "refund_venue",
        idempotencyKey: body.idempotencyKey,
        effects: [
          {
            kind: "refund_funds",
            amountCents: 4_000,
            operationKey: body.idempotencyKey,
          },
        ],
      });
    });

    it("treats pay_performer as separate platform-funded goodwill", async () => {
      const bookingId = await confirmedBooking();
      const body = adjustmentBody({
        direction: "pay_performer",
        amountCents: AMOUNT + 6_000,
        reason: "extra set",
      });
      as(uAdmin);
      expect((await post(adjustPost, bookingId, body)).status).toBe(200);
      const rows = await adjustments(bookingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.creditParty).toBe(`performer:${performerId}`);
      const events = await adjustmentEvents(bookingId);
      expect(events[0]!.payload).toMatchObject({
        direction: "pay_performer",
        idempotencyKey: body.idempotencyKey,
        effects: [
          {
            kind: "release_funds",
            amountCents: AMOUNT + 6_000,
            operationKey: body.idempotencyKey,
          },
        ],
      });
    });

    it("counts base refunds against the original charge ceiling", async () => {
      const bookingId = await confirmedBooking();
      await runBookingTransition(bookingId, { kind: "VENUE_CANCELLED" }, uVenue);
      const baseRefunds = await db()
        .select({ amountCents: schema.ledgerEntries.amountCents })
        .from(schema.ledgerEntries)
        .where(
          and(
            eq(schema.ledgerEntries.bookingId, bookingId),
            eq(schema.ledgerEntries.entryType, "refund"),
          ),
        );
      const alreadyRefunded = baseRefunds.reduce(
        (sum, row) => sum + row.amountCents,
        0,
      );
      as(uAdmin);

      const response = await post(
        adjustPost,
        bookingId,
        adjustmentBody({ amountCents: AMOUNT - alreadyRefunded + 1 }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "refund_exceeds_charge" },
      });
      expect(await adjustments(bookingId)).toHaveLength(0);
    });

    it("serializes concurrent refunds so their sum cannot exceed the charge", async () => {
      const bookingId = await settledBooking();
      const first = adjustmentBody({
        amountCents: 20_000,
        reason: "first concurrent refund",
      });
      const second = adjustmentBody({
        amountCents: 20_000,
        reason: "second concurrent refund",
      });
      as(uAdmin);

      const responses = await Promise.all([
        post(adjustPost, bookingId, first),
        post(adjustPost, bookingId, second),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200,
        409,
      ]);
      expect(await adjustments(bookingId)).toHaveLength(1);
      expect(await adjustmentEvents(bookingId)).toHaveLength(1);
    });

    it("retries one operation without duplicating its ledger row or event", async () => {
      const bookingId = await settledBooking();
      const body = adjustmentBody({ amountCents: 4_000, reason: "retryable goodwill" });
      as(uAdmin);

      const first = await post(adjustPost, bookingId, body);
      const retry = await post(adjustPost, bookingId, body);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ duplicate: false });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ duplicate: true });
      expect(await adjustments(bookingId)).toHaveLength(1);
      expect(await adjustmentEvents(bookingId)).toHaveLength(1);
    });

    it("allows two intentional identical adjustments with distinct operation keys", async () => {
      const bookingId = await settledBooking();
      const first = adjustmentBody({ amountCents: 4_000, reason: "separate goodwill" });
      const second = adjustmentBody({ amountCents: 4_000, reason: "separate goodwill" });
      as(uAdmin);

      expect((await post(adjustPost, bookingId, first)).status).toBe(200);
      expect((await post(adjustPost, bookingId, second)).status).toBe(200);
      expect(await adjustments(bookingId)).toHaveLength(2);
      expect(await adjustmentEvents(bookingId)).toHaveLength(2);
    });

    it("rejects reusing one operation key for different adjustment content", async () => {
      const bookingId = await settledBooking();
      const first = adjustmentBody({ amountCents: 4_000, reason: "original goodwill" });
      const changed = { ...first, amountCents: 6_000 };
      as(uAdmin);

      expect((await post(adjustPost, bookingId, first)).status).toBe(200);
      expect((await post(adjustPost, bookingId, changed)).status).toBe(409);
      expect(await adjustments(bookingId)).toHaveLength(1);
      expect(await adjustmentEvents(bookingId)).toHaveLength(1);
    });
  });
});
