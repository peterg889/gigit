import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { newId } from "@gigit/domain";
import {
  closeDb,
  createOffer,
  createTechSubslot,
  db,
  getPool,
  runBookingTransition,
  runSubslotTransition,
  schema,
} from "@gigit/db";
import { drainOutboxOnce } from "./index.js";

/**
 * Audit #1 (worker cascade): a parent booking that resolves to `refunded` or
 * `partially_released` (post-gig, via dispute) must still settle its tech
 * sub-slots — the gig happened, so the tech is paid. Before the fix the worker
 * only cascaded `released`/`cancelled_*`, stranding a booked sub-slot in
 * `booked` forever. These synthetic booking.transition events carry empty
 * effects, so the cascade branch is the only thing exercised → a stub boss is
 * fine.
 */
const noBoss = {} as unknown as PgBoss;

describe("worker parent→subslot cascade for dispute outcomes (audit #1)", () => {
  const userV = newId("user");
  const userP = newId("user");
  const userT = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: userV, email: `${userV}@t.test` },
      { id: userP, email: `${userP}@t.test` },
      { id: userT, email: `${userT}@t.test` },
    ]);
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: userV,
      kind: "bar",
      name: "Cascade Bar",
      metro: "cascadeville",
      lat: 43,
      lng: -88,
      paInventory: { hasPA: false },
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: userP,
      kind: "band",
      name: "Cascade Band",
      homeMetro: "cascadeville",
      techNeeds: { inputs: 8 },
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: userT,
      name: "Cascade Tech",
      gear: "full_rig",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  /** A confirmed parent booking with a tech sub-slot already booked. */
  async function bookedSubslot(): Promise<{ bookingId: string; subslotId: string }> {
    const d = db();
    const slotId = newId("slot");
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "cascadeville",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
    });
    const appId = newId("application");
    await d.insert(schema.applications).values({ id: appId, slotId, performerId });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userV,
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userP);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "test");
    const subslotId = await createTechSubslot({
      bookingId,
      payer: "venue",
      budgetCents: 25_000,
      actor: userV,
    });
    await runSubslotTransition(subslotId, { kind: "TECH_BOOKED", techId }, userV);
    return { bookingId, subslotId };
  }

  /** Park all pending outbox rows so a drain only sees the one we inject. */
  async function clearOutbox() {
    await getPool().query(
      `update events set dispatched_at = now()
       where dispatched_at is null and dead_lettered_at is null`,
    );
  }

  async function injectParentTransition(bookingId: string, to: string) {
    await getPool().query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('worker','booking.transition','booking',$1,$2::jsonb)`,
      [bookingId, JSON.stringify({ to, effects: [] })],
    );
  }

  it("a parent resolving to 'refunded' releases the booked tech (not stranded)", async () => {
    const { bookingId, subslotId } = await bookedSubslot();
    await clearOutbox();
    await injectParentTransition(bookingId, "refunded");
    await drainOutboxOnce(noBoss);

    const [s] = await db()
      .select()
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, subslotId));
    expect(s!.state).toBe("released");
  });

  it("a parent resolving to 'partially_released' also releases the booked tech", async () => {
    const { bookingId, subslotId } = await bookedSubslot();
    await clearOutbox();
    await injectParentTransition(bookingId, "partially_released");
    await drainOutboxOnce(noBoss);

    const [s] = await db()
      .select()
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, subslotId));
    expect(s!.state).toBe("released");
  });
});
