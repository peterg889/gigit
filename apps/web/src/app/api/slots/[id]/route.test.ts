import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { DELETE, PATCH } from "./route";

const patchReq = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://test/api/slots/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
const deleteReq = (id: string) =>
  DELETE(new Request(`http://test/api/slots/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

describe("slot lifecycle route — edit/close + authz (audit #11)", () => {
  const owner = newId("user");
  const stranger = newId("user");
  const venueId = newId("venue");
  const pId = newId("performer");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: owner, email: `${owner}@t.test` },
      { id: stranger, email: `${stranger}@t.test` },
    ]);
    await d.insert(schema.venues).values([
      {
        id: venueId,
        ownerUserId: owner,
        kind: "bar",
        name: "Lifecycle Bar",
        metro: "lc-testville",
        lat: 43,
        lng: -88,
      },
      // stranger owns a DIFFERENT venue, so the non-owner test exercises the real
      // cross-venue guard (slot.venueId !== venue.id), not "no venue profile".
      {
        id: newId("venue"),
        ownerUserId: stranger,
        kind: "bar",
        name: "Stranger's Bar",
        metro: "lc-testville",
        lat: 43,
        lng: -88,
      },
    ]);
    await d.insert(schema.performers).values({
      id: pId,
      ownerUserId: stranger,
      kind: "band",
      name: "Lifecycle Band",
      homeMetro: "lc-testville",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  async function openSlot() {
    const id = newId("slot");
    await db().insert(schema.slots).values({
      id,
      venueId,
      metro: "lc-testville",
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    return id;
  }

  it("owner edits an open slot's budget and notes", async () => {
    sessionUserId.mockResolvedValue(owner);
    const id = await openSlot();
    const res = await patchReq(id, { budgetCents: 45_000, notes: "earlier set" });
    expect(res.status).toBe(200);
    const [s] = await db().select().from(schema.slots).where(eq(schema.slots.id, id));
    expect(s!.budgetCents).toBe(45_000);
    expect(s!.notes).toBe("earlier set");
  });

  it("owner closes an open slot → status 'cancelled'", async () => {
    sessionUserId.mockResolvedValue(owner);
    const id = await openSlot();
    expect((await deleteReq(id)).status).toBe(200);
    const [s] = await db().select().from(schema.slots).where(eq(schema.slots.id, id));
    expect(s!.status).toBe("cancelled");
  });

  it("a non-owner can neither edit nor close (403, no IDOR)", async () => {
    const id = await openSlot();
    sessionUserId.mockResolvedValue(stranger);
    expect((await patchReq(id, { budgetCents: 1 })).status).toBe(403);
    expect((await deleteReq(id)).status).toBe(403);
    const [s] = await db().select().from(schema.slots).where(eq(schema.slots.id, id));
    expect(s!.status).toBe("open"); // untouched
    expect(s!.budgetCents).toBe(30_000);
  });

  it("a closed slot can't be edited (409); unauthenticated is 401", async () => {
    sessionUserId.mockResolvedValue(owner);
    const id = await openSlot();
    await deleteReq(id);
    expect((await patchReq(id, { budgetCents: 9_999 })).status).toBe(409);

    sessionUserId.mockResolvedValue(null);
    expect((await deleteReq(await openSlot())).status).toBe(401);
  });

  it("won't close a slot that has an outstanding offer (409 — no orphaned booking)", async () => {
    const id = await openSlot();
    const appId = newId("application");
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    await db().insert(schema.applications).values({ id: appId, slotId: id, performerId: pId });
    await createOffer({
      applicationId: appId,
      slotId: id,
      performerId: pId,
      venueId,
      actor: owner,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    sessionUserId.mockResolvedValue(owner);
    expect((await deleteReq(id)).status).toBe(409);
    const [s] = await db().select().from(schema.slots).where(eq(schema.slots.id, id));
    expect(s!.status).toBe("open"); // still open — the offer wasn't orphaned
  });
});
