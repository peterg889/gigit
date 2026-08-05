import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import {
  performerOwnedBy,
  profileCapabilitiesOwnedBy,
  techOwnedBy,
  venueOwnedBy,
} from "./auth";

describe("profile ownership lookup", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("prefers live, then suspended, then falls back by creation time and ID", async () => {
    const ownerUserId = newId("user");
    const prefix = ownerUserId.replaceAll("_", "-");
    const oldAt = new Date("2025-01-01T00:00:00.000Z");
    const liveAt = new Date("2026-01-01T00:00:00.000Z");
    await db().insert(schema.users).values({
      id: ownerUserId,
      email: `${ownerUserId}@profile-order.test`,
    });

    const performerA = `${prefix}-performer-a`;
    const performerB = `${prefix}-performer-b`;
    const performerLive = `${prefix}-performer-live`;
    await db().insert(schema.performers).values([
      { id: performerB, ownerUserId, kind: "band", name: "Old act B", homeMetro: "test", status: "hidden", createdAt: oldAt },
      { id: performerA, ownerUserId, kind: "band", name: "Old act A", homeMetro: "test", status: "hidden", createdAt: oldAt },
      { id: performerLive, ownerUserId, kind: "band", name: "Live act", homeMetro: "test", status: "live", createdAt: liveAt },
    ]);

    const venueA = `${prefix}-venue-a`;
    const venueB = `${prefix}-venue-b`;
    const venueLive = `${prefix}-venue-live`;
    await db().insert(schema.venues).values([
      { id: venueB, ownerUserId, kind: "bar", name: "Old room B", metro: "test", status: "hidden", createdAt: oldAt },
      { id: venueA, ownerUserId, kind: "bar", name: "Old room A", metro: "test", status: "hidden", createdAt: oldAt },
      { id: venueLive, ownerUserId, kind: "bar", name: "Live room", metro: "test", status: "live", createdAt: liveAt },
    ]);

    const techA = `${prefix}-tech-a`;
    const techB = `${prefix}-tech-b`;
    const techLive = `${prefix}-tech-live`;
    await db().insert(schema.techs).values([
      { id: techB, ownerUserId, name: "Old tech B", gear: "none", status: "hidden", createdAt: oldAt },
      { id: techA, ownerUserId, name: "Old tech A", gear: "none", status: "hidden", createdAt: oldAt },
      { id: techLive, ownerUserId, name: "Live tech", gear: "none", status: "live", createdAt: liveAt },
    ]);

    expect((await performerOwnedBy(ownerUserId))?.id).toBe(performerLive);
    expect((await venueOwnedBy(ownerUserId))?.id).toBe(venueLive);
    expect((await techOwnedBy(ownerUserId))?.id).toBe(techLive);
    const activeCapabilities = await profileCapabilitiesOwnedBy(ownerUserId);
    expect(activeCapabilities.live.performer?.id).toBe(performerLive);
    expect(activeCapabilities.live.venue?.id).toBe(venueLive);
    expect(activeCapabilities.live.tech?.id).toBe(techLive);

    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, ownerUserId));
    const inactiveAccount = await profileCapabilitiesOwnedBy(ownerUserId);
    expect(inactiveAccount.owned.performer?.id).toBe(performerLive);
    expect(inactiveAccount.owned.venue?.id).toBe(venueLive);
    expect(inactiveAccount.owned.tech?.id).toBe(techLive);
    expect(Object.values(inactiveAccount.live).every((profile) => profile === null)).toBe(true);
    await db()
      .update(schema.users)
      .set({ status: "active" })
      .where(eq(schema.users.id, ownerUserId));

    await db()
      .update(schema.performers)
      .set({ status: "suspended" })
      .where(eq(schema.performers.id, performerLive));
    await db()
      .update(schema.venues)
      .set({ status: "suspended" })
      .where(eq(schema.venues.id, venueLive));
    await db()
      .update(schema.techs)
      .set({ status: "suspended" })
      .where(eq(schema.techs.id, techLive));

    expect((await performerOwnedBy(ownerUserId))?.id).toBe(performerLive);
    expect((await venueOwnedBy(ownerUserId))?.id).toBe(venueLive);
    expect((await techOwnedBy(ownerUserId))?.id).toBe(techLive);
    const historicalProfiles = await profileCapabilitiesOwnedBy(ownerUserId);
    expect(historicalProfiles.owned.performer?.id).toBe(performerLive);
    expect(historicalProfiles.owned.venue?.id).toBe(venueLive);
    expect(historicalProfiles.owned.tech?.id).toBe(techLive);
    expect(Object.values(historicalProfiles.live).every((profile) => profile === null)).toBe(true);


    await db()
      .update(schema.performers)
      .set({ status: "hidden" })
      .where(eq(schema.performers.id, performerLive));
    await db()
      .update(schema.venues)
      .set({ status: "hidden" })
      .where(eq(schema.venues.id, venueLive));
    await db()
      .update(schema.techs)
      .set({ status: "hidden" })
      .where(eq(schema.techs.id, techLive));

    expect((await performerOwnedBy(ownerUserId))?.id).toBe(performerA);
    expect((await venueOwnedBy(ownerUserId))?.id).toBe(venueA);
    expect((await techOwnedBy(ownerUserId))?.id).toBe(techA);
  });
});
