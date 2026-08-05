import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

describe("tech cancellation route parent availability", () => {
  const venueOwnerId = newId("user");
  const performerOwnerId = newId("user");
  const techOwnerId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");
  let futureSubslotId: string;
  let closedSubslotId: string;
  let pastSubslotId: string;

  async function seedBookedSoundJob(input: {
    startsAt: Date;
    bookingState: string;
  }): Promise<string> {
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const subslotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "cancel-sound",
      startsAt: input.startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: input.bookingState === "confirmed" ? "filled" : "cancelled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: input.bookingState,
      terms: {
        amountCents: 30_000,
        startsAt: input.startsAt.toISOString(),
        endsAt: new Date(
          input.startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
      offerExpiresAt: new Date(input.startsAt.getTime() - 86_400_000),
    });
    await db().insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 10_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      state: "booked",
      techId,
    });
    await db().insert(schema.techSubslotApplications).values({
      id: newId("application"),
      subslotId,
      techId,
      status: "booked",
    });
    return subslotId;
  }

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: venueOwnerId, email: `${venueOwnerId}@cancel-sound.test` },
      { id: performerOwnerId, email: `${performerOwnerId}@cancel-sound.test` },
      { id: techOwnerId, email: `${techOwnerId}@cancel-sound.test` },
    ]);
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Cancel Sound Room",
      metro: "cancel-sound",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwnerId,
      kind: "band",
      name: "Cancel Sound Act",
      homeMetro: "cancel-sound",
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: techOwnerId,
      name: "Cancel Sound Tech",
      gear: "full_rig",
    });
    futureSubslotId = await seedBookedSoundJob({
      startsAt: new Date(Date.now() + 10 * 86_400_000),
      bookingState: "confirmed",
    });
    closedSubslotId = await seedBookedSoundJob({
      startsAt: new Date(Date.now() + 11 * 86_400_000),
      bookingState: "cancelled_by_venue",
    });
    pastSubslotId = await seedBookedSoundJob({
      startsAt: new Date(Date.now() - 60_000),
      bookingState: "confirmed",
    });
    sessionUserId.mockResolvedValue(techOwnerId);
  });

  afterAll(async () => {
    await closeDb();
  });

  const cancel = (subslotId: string) =>
    POST(new Request(`http://test/api/tech-subslots/${subslotId}/cancel`), {
      params: Promise.resolve({ id: subslotId }),
    });

  it("still lets an assigned tech reopen a future confirmed job", async () => {
    const response = await cancel(futureSubslotId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "open" });
  });

  it.each([
    ["closed parent", () => closedSubslotId],
    ["past downbeat", () => pastSubslotId],
  ])("returns a clean conflict for %s without reopening", async (_label, id) => {
    const subslotId = id();
    const response = await cancel(subslotId);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "tech_subslot_parent_unavailable",
        message:
          "This sound job is no longer available because its booking changed or the gig has passed. Reload the page.",
      },
    });
    const [subslot] = await db()
      .select({ state: schema.techSubslots.state, techId: schema.techSubslots.techId })
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, subslotId));
    expect(subslot).toEqual({ state: "booked", techId });
  });
});
