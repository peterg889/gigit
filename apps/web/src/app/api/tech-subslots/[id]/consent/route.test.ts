import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as consent } from "./route";
import { POST as cancel } from "../cancel/route";
import { POST as apply } from "../applications/route";

/**
 * Who may answer for a bill proposed in someone else's name.
 *
 * A sound job names its payer, and `POST /api/bookings/[id]/tech-subslot` only
 * ever checked that the caller was A party to the booking — so an act could
 * post payer:"venue" and the venue found out it owed a tech by reading its own
 * booking page. Such a job now waits in `awaiting_payer`, and this file is the
 * authorization matrix for getting it out of there: the named payer accepts or
 * declines, the proposer may take its own ask back, and NOBODY else has a say.
 *
 * Every case asserts the stored state as well as the status code — a 403 that
 * still moved the row would be the same bug wearing a different response.
 */
describe("sound-job consent authorization", () => {
  const venueOwnerId = newId("user");
  const performerOwnerId = newId("user");
  const techOwnerId = newId("user");
  const strangerId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");
  const startsAt = new Date(Date.now() + 10 * 86_400_000);

  /** One booking per proposal: a pending job holds the booking's sound slot. */
  async function seedProposal(
    payer: "venue" | "performer" = "venue",
    state = "awaiting_payer",
  ): Promise<string> {
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const subslotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "consent-sound",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    await db().insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer,
      budgetCents: 15_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
      state,
    });
    return subslotId;
  }

  const stateOf = async (subslotId: string) =>
    (
      await db()
        .select({ state: schema.techSubslots.state })
        .from(schema.techSubslots)
        .where(eq(schema.techSubslots.id, subslotId))
    )[0]!.state;

  const answer = (subslotId: string, decision: string) =>
    consent(
      new Request(`http://test/api/tech-subslots/${subslotId}/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      }),
      { params: Promise.resolve({ id: subslotId }) },
    );

  const withdraw = (subslotId: string) =>
    cancel(new Request(`http://test/api/tech-subslots/${subslotId}/cancel`), {
      params: Promise.resolve({ id: subslotId }),
    });

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values(
      [venueOwnerId, performerOwnerId, techOwnerId, strangerId].map((id) => ({
        id,
        email: `${id}@consent-sound.test`,
      })),
    );
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Consent Sound Room",
      metro: "consent-sound",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      paInventory: { hasPA: false },
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwnerId,
      kind: "band",
      name: "Consent Sound Act",
      homeMetro: "consent-sound",
      techNeeds: { inputs: 6 },
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: techOwnerId,
      name: "Consent Sound Tech",
      gear: "full_rig",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("lets the named payer accept, which is the only thing that opens it", async () => {
    const subslotId = await seedProposal("venue");
    sessionUserId.mockResolvedValue(venueOwnerId);
    const response = await answer(subslotId, "accept");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "open" });
    expect(await stateOf(subslotId)).toBe("open");
  });

  it("lets the named payer decline, terminally and distinguishably", async () => {
    const subslotId = await seedProposal("venue");
    sessionUserId.mockResolvedValue(venueOwnerId);
    const response = await answer(subslotId, "decline");
    expect(response.status).toBe(200);
    // Not cancelled_by_payer: nothing was ever agreed to, so this is not a
    // party walking away from a commitment.
    expect(await response.json()).toEqual({ state: "declined_by_payer" });

    // And it stays declined — a second answer cannot resurrect the job.
    const again = await answer(subslotId, "accept");
    expect(again.status).toBe(409);
    expect(await stateOf(subslotId)).toBe("declined_by_payer");
  });

  it.each([
    ["the party that proposed it", () => performerOwnerId],
    ["a sound tech", () => techOwnerId],
    ["someone with no connection to the booking", () => strangerId],
  ])("refuses %s an accept or a decline", async (_label, actor) => {
    const subslotId = await seedProposal("venue");
    for (const decision of ["accept", "decline"]) {
      sessionUserId.mockResolvedValue(actor());
      const response = await answer(subslotId, decision);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "forbidden",
          message:
            "Only the side named to pay for sound can accept or decline this job.",
        },
      });
      expect(await stateOf(subslotId)).toBe("awaiting_payer");
    }
  });

  it("reads the payer off the job, not off the caller's side of the booking", async () => {
    // Same two people, opposite bill: with payer:"performer" the venue is the
    // one with no say. A check that hard-coded "the venue decides" — or that
    // asked only "are you a party?" — passes the case above and fails here.
    const subslotId = await seedProposal("performer");
    sessionUserId.mockResolvedValue(venueOwnerId);
    expect((await answer(subslotId, "accept")).status).toBe(403);
    expect(await stateOf(subslotId)).toBe("awaiting_payer");

    sessionUserId.mockResolvedValue(performerOwnerId);
    expect((await answer(subslotId, "accept")).status).toBe(200);
    expect(await stateOf(subslotId)).toBe("open");
  });

  it("lets the proposer withdraw its own ask, and nobody else's", async () => {
    const subslotId = await seedProposal("venue");
    for (const actor of [techOwnerId, strangerId]) {
      sessionUserId.mockResolvedValue(actor);
      expect((await withdraw(subslotId)).status).toBe(403);
      expect(await stateOf(subslotId)).toBe("awaiting_payer");
    }
    sessionUserId.mockResolvedValue(performerOwnerId);
    const response = await withdraw(subslotId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "withdrawn_by_proposer" });
  });

  it("does not turn withdrawal into a veto over a live sound job", async () => {
    // The proposer's authority comes from the PENDING state, not from being a
    // party. Once the venue is funding an open job, the act cannot close it.
    const subslotId = await seedProposal("venue", "open");
    sessionUserId.mockResolvedValue(performerOwnerId);
    const response = await withdraw(subslotId);
    expect(response.status).toBe(403);
    expect(await stateOf(subslotId)).toBe("open");
  });

  it("keeps techs out of a job nobody has agreed to pay for", async () => {
    const subslotId = await seedProposal("venue");
    sessionUserId.mockResolvedValue(techOwnerId);
    const response = await apply(
      new Request(`http://test/api/tech-subslots/${subslotId}/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "I can cover it" }),
      }),
      { params: Promise.resolve({ id: subslotId }) },
    );
    expect(response.status).toBe(409);
    const applications = await db()
      .select({ id: schema.techSubslotApplications.id })
      .from(schema.techSubslotApplications)
      .where(eq(schema.techSubslotApplications.subslotId, subslotId));
    expect(applications).toEqual([]);
  });
});
