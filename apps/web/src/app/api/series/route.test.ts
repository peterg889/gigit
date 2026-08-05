import {
  localDateTimeParts,
  newId,
  zonedDateTimeToDate,
} from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

describe("create recurring series route", () => {
  const ownerId = newId("user");
  const venueId = newId("venue");
  const timeZone = "America/Chicago";

  beforeAll(async () => {
    await db().insert(schema.users).values({
      id: ownerId,
      email: `${ownerId}@series-route.test`,
    });
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: ownerId,
      kind: "brewery",
      name: "Anchored Series Route Room",
      metro: "anchored-series-route",
      addressLine1: "1 Anchor Ave",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone,
      paInventory: { hasPA: true },
    });
    sessionUserId.mockResolvedValue(ownerId);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("uses the selected first night as the persisted lower bound", async () => {
    const targetLocal = localDateTimeParts(
      new Date(Date.now() + 35 * 86_400_000),
      timeZone,
    );
    const selectedFirstNight = zonedDateTimeToDate(
      {
        year: targetLocal.year,
        month: targetLocal.month,
        day: targetLocal.day,
        hour: 19,
        minute: 45,
      },
      timeZone,
    );
    expect(selectedFirstNight.getTime() - 7 * 86_400_000).toBeGreaterThan(
      Date.now(),
    );

    const response = await POST(
      new Request("http://test/api/series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startsAt: selectedFirstNight.toISOString(),
          durationMinutes: 120,
          freq: "weekly",
          format: "music",
          genrePrefs: [],
          budgetCents: 42_500,
          provides: { pa: true },
          notes: "route anchor regression",
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { seriesId: string };

    const [series] = await db()
      .select({ pattern: schema.slotSeries.pattern })
      .from(schema.slotSeries)
      .where(eq(schema.slotSeries.id, body.seriesId));
    expect(series?.pattern.firstStartsAt).toBe(
      selectedFirstNight.toISOString(),
    );

    const occurrences = await db()
      .select({ startsAt: schema.slots.startsAt })
      .from(schema.slots)
      .where(eq(schema.slots.seriesId, body.seriesId))
      .orderBy(schema.slots.startsAt);
    expect(occurrences).toHaveLength(4);
    expect(occurrences[0]?.startsAt.toISOString()).toBe(
      selectedFirstNight.toISOString(),
    );
    expect(
      occurrences.filter(
        ({ startsAt }) => startsAt.getTime() === selectedFirstNight.getTime(),
      ),
    ).toHaveLength(1);
    expect(
      occurrences.every(
        ({ startsAt }) => startsAt.getTime() >= selectedFirstNight.getTime(),
      ),
    ).toBe(true);
  });
});
