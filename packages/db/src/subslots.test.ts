import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import { createOffer, runBookingTransition } from "./transition.js";
import {
  cascadeParentToSubslots,
  createTechSubslot,
  runSubslotTransition,
} from "./subslots.js";
import { bookingLedger } from "./ledger.js";
import {
  applications,
  ledgerEntries,
  performers,
  slots,
  techs,
  techSubslots,
  users,
  venues,
} from "./schema.js";

/** Full sub-slot lifecycle against real Postgres — the money must balance. */
describe("tech sub-slot runner (integration)", () => {
  const userV = newId("user");
  const userP = newId("user");
  const userT = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");
  // gig 36h out → payer cancellation lands in the 48h–14d window? No: <48h = 100%.
  const gigStart = new Date(Date.now() + 36 * 3_600_000);
  const gigEnd = new Date(gigStart.getTime() + 2 * 3_600_000);
  let bookingId: string;
  let subslotId: string;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: userV, email: `${userV}@t.test` },
      { id: userP, email: `${userP}@t.test` },
      { id: userT, email: `${userT}@t.test` },
    ]);
    await d.insert(venues).values({
      id: venueId,
      ownerUserId: userV,
      kind: "bar",
      name: "Subslot Test Bar",
      metro: "testville",
      lat: 43,
      lng: -87.9,
      paInventory: { hasPA: false },
    });
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: userP,
      kind: "band",
      name: "Subslot Test Band",
      homeMetro: "testville",
      techNeeds: { inputs: 8 },
    });
    await d.insert(techs).values({
      id: techId,
      ownerUserId: userT,
      name: "Subslot Test Tech",
      gear: "full_rig",
    });
    const slotId = newId("slot");
    await d.insert(slots).values({
      id: slotId,
      venueId,
      metro: "testville",
      startsAt: gigStart,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
    });
    const appId = newId("application");
    await d.insert(applications).values({ id: appId, slotId, performerId });
    bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userV,
      terms: {
        amountCents: 40_000,
        startsAt: gigStart.toISOString(),
        endsAt: gigEnd.toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userP);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "test");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates the sub-slot with the sound-plan snapshot from real profiles", async () => {
    subslotId = await createTechSubslot({
      bookingId,
      payer: "venue",
      budgetCents: 25_000,
      actor: userV,
      notes: "loud room",
    });
    const [s] = await db().select().from(techSubslots).where(eq(techSubslots.id, subslotId));
    expect(s.state).toBe("open");
    expect(s.needs.verdict).toBe("tech_and_rig_needed"); // no PA × 8 inputs
    expect(s.needs.inputs).toBe(8);
  });

  it("booking a tech writes exactly one charge ledger row for the payer", async () => {
    const r = await runSubslotTransition(subslotId, { kind: "TECH_BOOKED", techId }, userV);
    expect(r.to).toBe("booked");
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    const subCharges = rows.filter(
      (l) => l.entryType === "charge" && l.amountCents === 25_000,
    );
    expect(subCharges).toHaveLength(1);
    expect(subCharges[0]!.debitParty).toBe(`venue:${venueId}`);
  });

  it("re-running the same transition is rejected (no double charge)", async () => {
    await expect(
      runSubslotTransition(subslotId, { kind: "TECH_BOOKED", techId }, userV),
    ).rejects.toThrow();
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    expect(rows.filter((l) => l.entryType === "charge" && l.amountCents === 25_000)).toHaveLength(1);
  });

  it("tech cancellation refunds in full and reopens the sub-slot", async () => {
    const r = await runSubslotTransition(subslotId, { kind: "TECH_CANCELLED" }, userT);
    expect(r.to).toBe("open");
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    const refund = rows.find((l) => l.entryType === "refund" && l.amountCents === 25_000);
    expect(refund?.creditParty).toBe(`venue:${venueId}`);
    const [s] = await db().select().from(techSubslots).where(eq(techSubslots.id, subslotId));
    expect(s.techId).toBeNull();
    const [cancelledTech] = await db()
      .select({ strikes: techs.reliabilityStrikes })
      .from(techs)
      .where(eq(techs.id, techId));
    expect(cancelledTech!.strikes).toBe(1);
  });

  it("parent cancellation <48h out cascades: 100% of the sub-slot budget to the tech", async () => {
    // rebook, then cancel the parent booking
    await runSubslotTransition(subslotId, { kind: "TECH_BOOKED", techId }, userV);
    await runBookingTransition(bookingId, { kind: "VENUE_CANCELLED" }, userV);
    await cascadeParentToSubslots(bookingId, "cancelled", "worker");

    const [s] = await db().select().from(techSubslots).where(eq(techSubslots.id, subslotId));
    expect(s.state).toBe("cancelled_with_parent");
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    const techFee = rows.find(
      (l) => l.entryType === "fee" && l.creditParty === `tech:${techId}`,
    );
    expect(techFee?.amountCents).toBe(25_000); // <48h ⇒ 100%

    // money conserves across BOTH the booking and its sub-slot
    const totals = await bookingLedger(db(), bookingId);
    expect(totals.chargedCents).toBe(
      totals.releasedCents + totals.refundedCents,
    );
  });
});
