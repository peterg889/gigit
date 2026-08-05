import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import * as schema from "./schema.js";
import { deactivateAccount, setProfileVisibility } from "./account.js";

/**
 * A profile is the public face of an account: an act publishes an EPK, a venue
 * publishes a full street address. When the account stops being active the
 * public surfaces must stop serving it — previously nothing ever wrote a
 * non-live status, so a deactivated venue's address stayed up indefinitely.
 */
describe("profile visibility follows the account", () => {
  const owners: string[] = [];

  async function seedOwner() {
    const userId = newId("user");
    owners.push(userId);
    await db().insert(schema.users).values({ id: userId, email: `${userId}@t.test` });
    const performerId = newId("performer");
    const venueId = newId("venue");
    const techId = newId("tech");
    await db().insert(schema.performers).values({
      id: performerId, ownerUserId: userId, kind: "band", name: "Vis Act", homeMetro: "vis-tv",
    });
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: userId,
      kind: "bar",
      name: "Vis Room",
      metro: "vis-tv",
      addressLine1: "123 Private St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await db().insert(schema.techs).values({
      id: techId, ownerUserId: userId, name: "Vis Tech", gear: "full_rig",
    });
    return { userId, performerId, venueId, techId };
  }

  const statuses = async (ids: { performerId: string; venueId: string; techId: string }) => ({
    performer: (
      await db().select({ s: schema.performers.status }).from(schema.performers)
        .where(eq(schema.performers.id, ids.performerId))
    )[0]?.s,
    venue: (
      await db().select({ s: schema.venues.status }).from(schema.venues)
        .where(eq(schema.venues.id, ids.venueId))
    )[0]?.s,
    tech: (
      await db().select({ s: schema.techs.status }).from(schema.techs)
        .where(eq(schema.techs.id, ids.techId))
    )[0]?.s,
  });

  afterAll(async () => {
    await closeDb();
  });

  it("new profiles are live", async () => {
    const ids = await seedOwner();
    expect(await statuses(ids)).toEqual({ performer: "live", venue: "live", tech: "live" });
  });

  it("deactivating the account hides all three profiles (address no longer public)", async () => {
    const ids = await seedOwner();
    await deactivateAccount(ids.userId);
    expect(await statuses(ids)).toEqual({
      performer: "hidden",
      venue: "hidden",
      tech: "hidden",
    });
  });

  it("setProfileVisibility can suspend and restore all current profiles", async () => {
    const ids = await seedOwner();
    await setProfileVisibility(ids.userId, "suspended");
    expect(await statuses(ids)).toEqual({
      performer: "suspended",
      venue: "suspended",
      tech: "suspended",
    });
    await setProfileVisibility(ids.userId, "live");
    expect(await statuses(ids)).toEqual({ performer: "live", venue: "live", tech: "live" });
  });

  it("touches only the target account's profiles", async () => {
    const mine = await seedOwner();
    const theirs = await seedOwner();
    await setProfileVisibility(mine.userId, "hidden");
    expect((await statuses(theirs)).venue).toBe("live");
  });
});
