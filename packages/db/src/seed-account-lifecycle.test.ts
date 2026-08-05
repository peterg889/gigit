import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import {
  actorRoles,
  performers,
  slots,
  techs,
  users,
  venues,
} from "./schema.js";
import { ensureAccountLifecycleE2EJourneys } from "./seed-account-lifecycle.js";
import { E2E_JOURNEYS } from "./seed-fixtures.js";

describe("account-lifecycle E2E seed", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("is retry-safe, idempotent, and restores its intentionally mutated rows", async () => {
    const now = new Date("2030-06-15T12:00:00.000Z");
    const first = await ensureAccountLifecycleE2EJourneys(db(), now);
    const second = await ensureAccountLifecycleE2EJourneys(db(), now);
    expect(second).toEqual(first);
    expect(first).toHaveLength(E2E_JOURNEYS.lifecycle.attempts.length);

    const venueEmails = E2E_JOURNEYS.lifecycle.attempts.map(
      ({ venue }) => venue.email,
    );
    const adminEmails = E2E_JOURNEYS.lifecycle.attempts.map(
      ({ admin }) => admin.email,
    );
    expect(
      await db()
        .select({ email: users.email, status: users.status })
        .from(users)
        .where(inArray(users.email, [...venueEmails, ...adminEmails])),
    ).toHaveLength(4);

    for (const [index, ids] of first.entries()) {
      const fixture = E2E_JOURNEYS.lifecycle.attempts[index]!;
      expect(
        await db()
          .select({ id: actorRoles.id })
          .from(actorRoles)
          .where(
            and(
              eq(actorRoles.userId, ids.adminUserId),
              eq(actorRoles.kind, "admin"),
            ),
          ),
      ).toHaveLength(1);
      expect(
        await db()
          .select({ name: venues.name, status: venues.status })
          .from(venues)
          .where(eq(venues.id, ids.venueId)),
      ).toEqual([{ name: fixture.venue.name, status: "live" }]);
      const [slot] = await db()
        .select({ notes: slots.notes, startsAt: slots.startsAt, status: slots.status })
        .from(slots)
        .where(eq(slots.id, ids.slotId));
      expect(slot).toMatchObject({ notes: fixture.slot.marker, status: "open" });
      expect(slot!.startsAt.getTime()).toBeGreaterThan(now.getTime());
    }

    // Model the durable output of the browser journey. A subsequent seed run
    // must restore the same reserved ids even after the email was removed.
    const mutated = first[0]!;
    await db().transaction(async (tx) => {
      await tx
        .update(slots)
        .set({ status: "cancelled" })
        .where(eq(slots.id, mutated.slotId));
      await tx
        .update(venues)
        .set({ status: "hidden" })
        .where(eq(venues.id, mutated.venueId));
      await tx
        .update(users)
        .set({ email: null, status: "deleted", smsOptedOutAt: now })
        .where(eq(users.id, mutated.venueUserId));
    });

    const restored = await ensureAccountLifecycleE2EJourneys(db(), now);
    expect(restored).toEqual(first);
    expect(
      await db()
        .select({ email: users.email, status: users.status })
        .from(users)
        .where(eq(users.id, mutated.venueUserId)),
    ).toEqual([
      {
        email: E2E_JOURNEYS.lifecycle.attempts[0].venue.email,
        status: "active",
      },
    ]);
    expect(
      await db()
        .select({ status: venues.status })
        .from(venues)
        .where(eq(venues.id, mutated.venueId)),
    ).toEqual([{ status: "live" }]);
    expect(
      await db()
        .select({ status: slots.status })
        .from(slots)
        .where(eq(slots.id, mutated.slotId)),
    ).toEqual([{ status: "open" }]);
  });

  it("restores fixed no-commitment identities without creating profiles", async () => {
    const now = new Date("2030-06-15T12:00:00.000Z");
    await ensureAccountLifecycleE2EJourneys(db(), now);
    const attempts = E2E_JOURNEYS.lifecycle.deactivationAttempts;
    const accountIds = attempts.map(({ account }) => account.id);
    const adminIds = attempts.map(({ admin }) => admin.id);

    const accounts = await db()
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(inArray(users.id, accountIds));
    expect(accounts).toHaveLength(attempts.length);
    for (const { account } of attempts) {
      expect(accounts).toContainEqual({
        id: account.id,
        email: account.email,
        status: "active",
      });
    }
    expect(
      await db()
        .select({ id: actorRoles.id })
        .from(actorRoles)
        .where(
          and(
            inArray(actorRoles.userId, adminIds),
            eq(actorRoles.kind, "admin"),
          ),
        ),
    ).toHaveLength(attempts.length);
    expect(
      await db()
        .select({ id: performers.id })
        .from(performers)
        .where(inArray(performers.ownerUserId, accountIds)),
    ).toHaveLength(0);
    expect(
      await db()
        .select({ id: venues.id })
        .from(venues)
        .where(inArray(venues.ownerUserId, accountIds)),
    ).toHaveLength(0);
    expect(
      await db()
        .select({ id: techs.id })
        .from(techs)
        .where(inArray(techs.ownerUserId, accountIds)),
    ).toHaveLength(0);

    const first = attempts[0].account;
    await db()
      .update(users)
      .set({ email: null, status: "deleted", smsOptedOutAt: now })
      .where(eq(users.id, first.id));
    await ensureAccountLifecycleE2EJourneys(db(), now);
    expect(
      await db()
        .select({ id: users.id, email: users.email, status: users.status })
        .from(users)
        .where(eq(users.id, first.id)),
    ).toEqual([{ id: first.id, email: first.email, status: "active" }]);
  });
});
