import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const apply = (slotId: string, note = "We'd love to play.") =>
  POST(
    new Request(`http://test/api/slots/${slotId}/applications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    }),
    { params: Promise.resolve({ id: slotId }) },
  );

describe("slot applications", () => {
  afterAll(async () => {
    await closeDb();
  });

  async function slotAt(startsAt: Date) {
    const venue = await makeVenue({ name: "Application Room" });
    const slotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "application-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    return slotId;
  }

  it("rejects a stale submission after downbeat even before the expiry sweep", async () => {
    const performer = await makePerformer({ name: "Past Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const slotId = await slotAt(new Date(Date.now() - 60_000));

    const response = await apply(slotId);
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toMatch(/passed/i);
    const rows = await db()
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.slotId, slotId));
    expect(rows).toHaveLength(0);
  });

  it("still creates a submitted application for a future open date", async () => {
    const performer = await makePerformer({ name: "Future Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const slotId = await slotAt(new Date(Date.now() + 7 * 86_400_000));

    const response = await apply(slotId, "Two strong sets ready.");
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const [application] = await db()
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, id));
    expect(application).toMatchObject({
      slotId,
      performerId: performer.id,
      status: "submitted",
      note: "Two strong sets ready.",
    });
  });
});
