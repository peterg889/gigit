import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { inArray } from "drizzle-orm";
import { loadParticipantLabels } from "./thread-profile-labels";

describe("participant profile identity lookup", () => {
  const liveOwnerId = newId("user");
  const fallbackOwnerId = newId("user");

  afterAll(async () => {
    await db()
      .delete(schema.techs)
      .where(inArray(schema.techs.ownerUserId, [liveOwnerId, fallbackOwnerId]));
    await db()
      .delete(schema.venues)
      .where(inArray(schema.venues.ownerUserId, [liveOwnerId, fallbackOwnerId]));
    await db()
      .delete(schema.performers)
      .where(inArray(schema.performers.ownerUserId, [liveOwnerId, fallbackOwnerId]));
    await db()
      .delete(schema.users)
      .where(inArray(schema.users.id, [liveOwnerId, fallbackOwnerId]));
    await closeDb();
  });

  it("suppresses hidden same-role duplicates while retaining distinct roles", async () => {
    await db().insert(schema.users).values([
      { id: liveOwnerId, email: `${liveOwnerId}@thread-profile.test` },
      { id: fallbackOwnerId, email: `${fallbackOwnerId}@thread-profile.test` },
    ]);

    const hiddenActId = newId("performer");
    const liveActId = newId("performer");
    const techId = newId("tech");
    const fallbackPrefix = newId("performer");
    const fallbackActA = `${fallbackPrefix}-a`;
    const fallbackActB = `${fallbackPrefix}-b`;

    await db().insert(schema.performers).values([
      {
        id: hiddenActId,
        ownerUserId: liveOwnerId,
        kind: "band",
        name: "Hidden Historical Act",
        homeMetro: "test",
        status: "hidden",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: liveActId,
        ownerUserId: liveOwnerId,
        kind: "band",
        name: "Current Act",
        homeMetro: "test",
        status: "live",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: fallbackActB,
        ownerUserId: fallbackOwnerId,
        kind: "solo",
        name: "Fallback Act B",
        homeMetro: "test",
        status: "hidden",
        createdAt: new Date("2025-02-01T00:00:00Z"),
      },
      {
        id: fallbackActA,
        ownerUserId: fallbackOwnerId,
        kind: "solo",
        name: "Fallback Act A",
        homeMetro: "test",
        status: "hidden",
        createdAt: new Date("2025-02-01T00:00:00Z"),
      },
    ]);
    await db().insert(schema.techs).values({
      id: techId,
      ownerUserId: liveOwnerId,
      name: "Current Tech",
      gear: "none",
    });

    const labels = await loadParticipantLabels([
      liveOwnerId,
      fallbackOwnerId,
      liveOwnerId,
    ]);
    expect(labels.get(liveOwnerId)).toBe(
      "Current Act (act) · Current Tech (sound tech)",
    );
    expect(labels.get(liveOwnerId)).not.toContain("Hidden Historical Act");
    expect(labels.get(fallbackOwnerId)).toBe("Fallback Act A");

    await db()
      .update(schema.performers)
      .set({ status: "suspended" })
      .where(inArray(schema.performers.id, [liveActId]));
    const suspendedLabels = await loadParticipantLabels([liveOwnerId]);
    expect(suspendedLabels.get(liveOwnerId)).toBe(
      "Current Act (act) · Current Tech (sound tech)",
    );
    expect(suspendedLabels.get(liveOwnerId)).not.toContain(
      "Hidden Historical Act",
    );
  });
});
