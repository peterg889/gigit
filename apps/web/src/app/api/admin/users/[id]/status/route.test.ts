import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const setStatus = (id: string, status: string) =>
  POST(
    new Request(`http://test/api/admin/users/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id }) },
  );

/** Suspension is the platform's only enforcement lever at launch (F9.1). */
describe("admin user status route", () => {
  const uAdmin = newId("user");
  const uCivilian = newId("user");
  const uTarget = newId("user");

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [uAdmin, uCivilian, uTarget].map((id) => ({ id, email: `${id}@t.test` })),
      );
    await d
      .insert(schema.actorRoles)
      .values({ id: newId("role"), userId: uAdmin, kind: "admin" });
  });
  afterAll(async () => {
    await closeDb();
  });

  const statusOf = async (id: string) =>
    (
      await db()
        .select({ s: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, id))
    )[0]?.s;

  it("suspends and reinstates a user", async () => {
    as(uAdmin);
    expect((await setStatus(uTarget, "suspended")).status).toBe(200);
    expect(await statusOf(uTarget)).toBe("suspended");
    expect((await setStatus(uTarget, "active")).status).toBe(200);
    expect(await statusOf(uTarget)).toBe("active");
  });

  it("winds down active work and does not resurrect it on reinstatement", async () => {
    const userId = newId("user");
    const performerId = newId("performer");
    const venueOwnerId = newId("user");
    const venueId = newId("venue");
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const startsAt = new Date(Date.now() + 30 * 86_400_000);
    await db().insert(schema.users).values([
      { id: userId, email: `${userId}@t.test` },
      { id: venueOwnerId, email: `${venueOwnerId}@t.test` },
    ]);
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "band",
      name: "Admin Suspension Act",
      homeMetro: "status-test",
    });
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Admin Suspension Room",
      metro: "status-test",
    });
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "status-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });

    as(uAdmin);
    expect((await setStatus(userId, "suspended")).status).toBe(200);
    const [suspendedBooking] = await db()
      .select({ state: schema.bookings.state })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    const [reopenedSlot] = await db()
      .select({ status: schema.slots.status })
      .from(schema.slots)
      .where(eq(schema.slots.id, slotId));
    const [suspendedProfile] = await db()
      .select({ status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(suspendedBooking?.state).toBe("cancelled_by_performer");
    expect(reopenedSlot?.status).toBe("open");
    expect(suspendedProfile?.status).toBe("suspended");

    expect((await setStatus(userId, "active")).status).toBe(200);
    const [reinstatedBooking] = await db()
      .select({ state: schema.bookings.state })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    const [reinstatedProfile] = await db()
      .select({ status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(await statusOf(userId)).toBe("active");
    expect(reinstatedBooking?.state).toBe("cancelled_by_performer");
    expect(reinstatedProfile?.status).toBe("live");
  });

  it("restores the current profiles without reviving older hidden profiles", async () => {
    const userId = newId("user");
    const oldPerformer = newId("performer");
    const currentPerformer = newId("performer");
    const oldVenue = newId("venue");
    const currentVenue = newId("venue");
    const oldTech = newId("tech");
    const currentTech = newId("tech");
    const oldDate = new Date("2024-01-01T00:00:00.000Z");
    const currentDate = new Date("2025-01-01T00:00:00.000Z");
    await db().insert(schema.users).values({
      id: userId,
      email: `${userId}@t.test`,
    });
    await db().insert(schema.performers).values([
      {
        id: oldPerformer,
        ownerUserId: userId,
        kind: "solo",
        name: "Archived Act",
        homeMetro: "status-test",
        status: "hidden",
        createdAt: oldDate,
      },
      {
        id: currentPerformer,
        ownerUserId: userId,
        kind: "band",
        name: "Current Act",
        homeMetro: "status-test",
        status: "live",
        createdAt: currentDate,
      },
    ]);
    await db().insert(schema.venues).values([
      {
        id: oldVenue,
        ownerUserId: userId,
        kind: "bar",
        name: "Archived Room",
        metro: "status-test",
        status: "hidden",
        createdAt: oldDate,
      },
      {
        id: currentVenue,
        ownerUserId: userId,
        kind: "bar",
        name: "Current Room",
        metro: "status-test",
        status: "live",
        createdAt: currentDate,
      },
    ]);
    await db().insert(schema.techs).values([
      {
        id: oldTech,
        ownerUserId: userId,
        name: "Archived Tech",
        gear: "none",
        status: "hidden",
        createdAt: oldDate,
      },
      {
        id: currentTech,
        ownerUserId: userId,
        name: "Current Tech",
        gear: "full_rig",
        status: "live",
        createdAt: currentDate,
      },
    ]);

    const profileStatuses = async () => ({
      performers: await db()
        .select({ id: schema.performers.id, status: schema.performers.status })
        .from(schema.performers)
        .where(eq(schema.performers.ownerUserId, userId))
        .orderBy(schema.performers.createdAt),
      venues: await db()
        .select({ id: schema.venues.id, status: schema.venues.status })
        .from(schema.venues)
        .where(eq(schema.venues.ownerUserId, userId))
        .orderBy(schema.venues.createdAt),
      techs: await db()
        .select({ id: schema.techs.id, status: schema.techs.status })
        .from(schema.techs)
        .where(eq(schema.techs.ownerUserId, userId))
        .orderBy(schema.techs.createdAt),
    });

    as(uAdmin);
    expect((await setStatus(userId, "suspended")).status).toBe(200);
    expect(await profileStatuses()).toEqual({
      performers: [
        { id: oldPerformer, status: "hidden" },
        { id: currentPerformer, status: "suspended" },
      ],
      venues: [
        { id: oldVenue, status: "hidden" },
        { id: currentVenue, status: "suspended" },
      ],
      techs: [
        { id: oldTech, status: "hidden" },
        { id: currentTech, status: "suspended" },
      ],
    });

    expect((await setStatus(userId, "active")).status).toBe(200);
    expect(await profileStatuses()).toEqual({
      performers: [
        { id: oldPerformer, status: "hidden" },
        { id: currentPerformer, status: "live" },
      ],
      venues: [
        { id: oldVenue, status: "hidden" },
        { id: currentVenue, status: "live" },
      ],
      techs: [
        { id: oldTech, status: "hidden" },
        { id: currentTech, status: "live" },
      ],
    });
  });

  it("reactivates exactly one deterministic legacy profile of each type", async () => {
    const userId = newId("user");
    const suffix = userId.slice(4).toLowerCase();
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const performerA = `prf_${suffix}_a`;
    const performerB = `prf_${suffix}_b`;
    const venueA = `ven_${suffix}_a`;
    const venueB = `ven_${suffix}_b`;
    const techA = `tec_${suffix}_a`;
    const techB = `tec_${suffix}_b`;
    await db().insert(schema.users).values({
      id: userId,
      email: `${userId}@t.test`,
      status: "suspended",
    });
    await db().insert(schema.performers).values([
      {
        id: performerB,
        ownerUserId: userId,
        kind: "band",
        name: "Legacy Act B",
        homeMetro: "status-test",
        status: "hidden",
        createdAt,
      },
      {
        id: performerA,
        ownerUserId: userId,
        kind: "band",
        name: "Legacy Act A",
        homeMetro: "status-test",
        status: "hidden",
        createdAt,
      },
    ]);
    await db().insert(schema.venues).values([
      {
        id: venueB,
        ownerUserId: userId,
        kind: "bar",
        name: "Legacy Room B",
        metro: "status-test",
        status: "hidden",
        createdAt,
      },
      {
        id: venueA,
        ownerUserId: userId,
        kind: "bar",
        name: "Legacy Room A",
        metro: "status-test",
        status: "hidden",
        createdAt,
      },
    ]);
    await db().insert(schema.techs).values([
      {
        id: techB,
        ownerUserId: userId,
        name: "Legacy Tech B",
        gear: "none",
        status: "hidden",
        createdAt,
      },
      {
        id: techA,
        ownerUserId: userId,
        name: "Legacy Tech A",
        gear: "none",
        status: "hidden",
        createdAt,
      },
    ]);

    as(uAdmin);
    expect((await setStatus(userId, "active")).status).toBe(200);
    expect(await statusOf(userId)).toBe("active");

    const performerRows = await db()
      .select({ id: schema.performers.id, status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.ownerUserId, userId))
      .orderBy(schema.performers.id);
    const venueRows = await db()
      .select({ id: schema.venues.id, status: schema.venues.status })
      .from(schema.venues)
      .where(eq(schema.venues.ownerUserId, userId))
      .orderBy(schema.venues.id);
    const techRows = await db()
      .select({ id: schema.techs.id, status: schema.techs.status })
      .from(schema.techs)
      .where(eq(schema.techs.ownerUserId, userId))
      .orderBy(schema.techs.id);
    expect(performerRows).toEqual([
      { id: performerA, status: "live" },
      { id: performerB, status: "hidden" },
    ]);
    expect(venueRows).toEqual([
      { id: venueA, status: "live" },
      { id: venueB, status: "hidden" },
    ]);
    expect(techRows).toEqual([
      { id: techA, status: "live" },
      { id: techB, status: "hidden" },
    ]);
  });

  it("rolls back the account and profiles when the audit event cannot commit", async () => {
    const userId = newId("user");
    const performerId = newId("performer");
    await db().insert(schema.users).values({ id: userId, email: `${userId}@t.test` });
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "solo",
      name: "Atomic Status Act",
      homeMetro: "status-test",
    });
    const venueOwnerId = newId("user");
    const venueId = newId("venue");
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const startsAt = new Date(Date.now() + 31 * 86_400_000);
    await db().insert(schema.users).values({
      id: venueOwnerId,
      email: `${venueOwnerId}@t.test`,
    });
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Atomic Status Room",
      metro: "status-test",
    });
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "status-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    const suffix = userId.slice(-16).toLowerCase();
    const functionName = `fail_status_event_${suffix}`;
    const triggerName = `fail_status_event_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.subject_id = '${userId}' and new.kind = 'user.suspended' then
          raise exception 'forced status event failure';
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

    try {
      as(uAdmin);
      await expect(setStatus(userId, "suspended")).rejects.toThrow(
        'Failed query: insert into "events"',
      );
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    expect(await statusOf(userId)).toBe("active");
    const [performer] = await db()
      .select({ status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(performer?.status).toBe("live");
    const [booking] = await db()
      .select({ state: schema.bookings.state })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    const [slot] = await db()
      .select({ status: schema.slots.status })
      .from(schema.slots)
      .where(eq(schema.slots.id, slotId));
    expect(booking?.state).toBe("confirmed");
    expect(slot?.status).toBe("filled");
  });

  it("does not reactivate a deleted account or republish its hidden profiles", async () => {
    const userId = newId("user");
    const performerId = newId("performer");
    const venueId = newId("venue");
    const techId = newId("tech");
    await db().insert(schema.users).values({
      id: userId,
      email: null,
      phone: null,
      status: "deleted",
    });
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "band",
      name: "Deleted Account Act",
      homeMetro: "status-test",
      status: "hidden",
    });
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: userId,
      kind: "bar",
      name: "Deleted Account Room",
      metro: "status-test",
      addressLine1: "Private after deactivation",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      status: "hidden",
    });
    await db().insert(schema.techs).values({
      id: techId,
      ownerUserId: userId,
      name: "Deleted Account Tech",
      gear: "none",
      status: "hidden",
    });

    as(uAdmin);
    for (const requestedStatus of ["active", "suspended"] as const) {
      const response = await setStatus(userId, requestedStatus);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatchObject({
        code: "conflict",
      });
    }

    expect(await statusOf(userId)).toBe("deleted");
    const [performer] = await db()
      .select({ status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    const [venue] = await db()
      .select({ status: schema.venues.status })
      .from(schema.venues)
      .where(eq(schema.venues.id, venueId));
    const [tech] = await db()
      .select({ status: schema.techs.status })
      .from(schema.techs)
      .where(eq(schema.techs.id, techId));
    expect({
      performer: performer?.status,
      venue: venue?.status,
      tech: tech?.status,
    }).toEqual({
      performer: "hidden",
      venue: "hidden",
      tech: "hidden",
    });
    const statusEvents = await db()
      .select({ kind: schema.events.kind })
      .from(schema.events)
      .where(eq(schema.events.subjectId, userId));
    expect(
      statusEvents.filter(
        (event) =>
          event.kind === "user.active" || event.kind === "user.suspended",
      ),
    ).toHaveLength(0);
  });

  it("rejects a non-admin", async () => {
    as(uCivilian);
    expect((await setStatus(uTarget, "suspended")).status).toBe(403);
    expect(await statusOf(uTarget)).toBe("active");
  });

  it("rejects invalid status values", async () => {
    as(uAdmin);
    expect((await setStatus(uTarget, "deleted")).status).toBe(422);
  });

  it("404s for an unknown user", async () => {
    as(uAdmin);
    expect((await setStatus(newId("user"), "suspended")).status).toBe(404);
  });
});
