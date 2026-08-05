import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makeVenue, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { GET, PATCH } from "./route";

describe("venue profile clearing", () => {
  let venue: Awaited<ReturnType<typeof makeVenue>>;

  beforeAll(async () => {
    venue = await makeVenue({ name: "Clearable Room" });
    await db()
      .update(schema.venues)
      .set({
        bio: "Saved room copy",
        addressLine2: "Suite 2",
        capacity: 120,
        noiseCurfew: "11pm",
        paInventory: {
          hasPA: true,
          mixerChannels: 12,
          micsAvailable: 4,
          monitors: 2,
          hasOperator: true,
        },
      })
      .where(eq(schema.venues.id, venue.id));
  });

  afterAll(async () => {
    await db().delete(schema.venues).where(eq(schema.venues.id, venue.id));
    await db().delete(schema.users).where(eq(schema.users.id, venue.ownerUserId));
    await closeDb();
  });

  it("persists explicit text, nullable number, and nested gear clears on reload", async () => {
    sessionUserId.mockResolvedValue(venue.ownerUserId);
    const response = await PATCH(
      new Request(`http://test/api/venues/${venue.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bio: "",
          addressLine2: "",
          capacity: null,
          noiseCurfew: "",
          paInventory: { hasPA: true },
        }),
      }),
      { params: Promise.resolve({ id: venue.id }) },
    );
    expect(response.status).toBe(200);

    const reloaded = await GET(new Request("http://test"), {
      params: Promise.resolve({ id: venue.id }),
    });
    expect(await reloaded.json()).toMatchObject({
      venue: {
        bio: "",
        addressLine2: "",
        capacity: null,
        noiseCurfew: "",
        paInventory: { hasPA: true },
      },
    });
  });
});
