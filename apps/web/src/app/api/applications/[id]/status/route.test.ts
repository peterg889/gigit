import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const call = (id: string, action: "decline" | "withdraw") =>
  POST(
    new Request(`http://test/api/applications/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("application outcome route", () => {
  const venueOwnerId = newId("user");
  const performerOwnerId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let sequence = 0;

  beforeAll(async () => {
    await db().insert(schema.users).values([
      { id: venueOwnerId, email: `${venueOwnerId}@application-status.test` },
      {
        id: performerOwnerId,
        email: `${performerOwnerId}@application-status.test`,
      },
    ]);
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Application Status Room",
      metro: "application-status",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      lat: 43,
      lng: -88,
    });
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwnerId,
      kind: "band",
      name: "Application Status Act",
      homeMetro: "application-status",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function submittedApplication() {
    const slotId = newId("slot");
    const applicationId = newId("application");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "application-status",
      startsAt: new Date(Date.now() + (14 + sequence++) * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db().insert(schema.applications).values({
      id: applicationId,
      slotId,
      performerId,
    });
    return { applicationId, slotId };
  }

  it("records a venue decline with truthful performer notification copy", async () => {
    const fixture = await submittedApplication();
    sessionUserId.mockResolvedValue(venueOwnerId);

    const response = await call(fixture.applicationId, "decline");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "declined" });

    const [application] = await db()
      .select({
        status: schema.applications.status,
        reason: schema.applications.declineReason,
      })
      .from(schema.applications)
      .where(eq(schema.applications.id, fixture.applicationId));
    expect(application).toEqual({
      status: "declined",
      reason: "venue_declined",
    });

    const [event] = await db()
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, fixture.slotId),
          eq(schema.events.kind, "application.declined"),
        ),
      );
    expect(event?.payload).toMatchObject({
      applicationId: fixture.applicationId,
      effects: [
        {
          kind: "notify",
          template: "application_not_selected",
          to: "performer",
        },
      ],
    });
  });

  it("records a performer withdrawal without notifying the performer", async () => {
    const fixture = await submittedApplication();
    sessionUserId.mockResolvedValue(performerOwnerId);

    const response = await call(fixture.applicationId, "withdraw");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "withdrawn" });

    const [event] = await db()
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, fixture.slotId),
          eq(schema.events.kind, "application.withdrawn"),
        ),
      );
    expect(event?.payload).toEqual({ applicationId: fixture.applicationId });
  });

  it("rolls the status back when its matching event cannot be persisted", async () => {
    const fixture = await submittedApplication();
    const suffix = fixture.slotId
      .replace(/[^a-z0-9]/gi, "")
      .slice(-16)
      .toLowerCase();
    const functionName = `fail_application_event_${suffix}`;
    const triggerName = `fail_application_event_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.subject_id = '${fixture.slotId}'
           and new.kind = 'application.declined' then
          raise exception 'forced application event failure';
        end if;
        return new;
      end
      $$
    `);
    await pool.query(`
      create trigger ${triggerName}
      before insert on events
      for each row execute function ${functionName}()
    `);

    sessionUserId.mockResolvedValue(venueOwnerId);
    try {
      await expect(call(fixture.applicationId, "decline")).rejects.toThrow();
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    const [application] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.id, fixture.applicationId));
    expect(application?.status).toBe("submitted");
    const events = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, fixture.slotId),
          eq(schema.events.kind, "application.declined"),
        ),
      );
    expect(events).toHaveLength(0);
  });
});
