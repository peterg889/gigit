import { newId } from "@gigit/domain";
import { and, asc, eq } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import {
  actorRoles,
  performers,
  slots,
  techs,
  users,
  venues,
} from "./schema.js";
import { E2E_JOURNEYS } from "./seed-fixtures.js";

type LifecycleAttempt = (typeof E2E_JOURNEYS.lifecycle.attempts)[number];
type DeactivationAttempt =
  (typeof E2E_JOURNEYS.lifecycle.deactivationAttempts)[number];

async function ensureResettableUser(
  tx: Tx,
  email: string,
  fallbackUserId?: string,
): Promise<string> {
  const [byEmail] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  const id = byEmail?.id ?? fallbackUserId ?? newId("user");

  if (byEmail || fallbackUserId) {
    await tx
      .update(users)
      .set({
        email,
        phone: null,
        status: "active",
        smsOptedOutAt: null,
      })
      .where(eq(users.id, id));
  } else {
    await tx.insert(users).values({ id, email });
  }
  return id;
}

async function ensureReservedUser(
  tx: Tx,
  identity: { id: string; email: string },
): Promise<string> {
  const [byId] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, identity.id));
  const [byEmail] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, identity.email));
  if (byEmail && byEmail.id !== identity.id) {
    throw new Error(
      `reserved lifecycle email ${identity.email} belongs to ${byEmail.id}`,
    );
  }

  if (byId) {
    await tx
      .update(users)
      .set({
        email: identity.email,
        phone: null,
        status: "active",
        smsOptedOutAt: null,
      })
      .where(eq(users.id, identity.id));
  } else {
    await tx.insert(users).values(identity);
  }
  return identity.id;
}

async function ensureAdminRole(tx: Tx, userId: string): Promise<void> {
  const [savedRole] = await tx
    .select({ id: actorRoles.id })
    .from(actorRoles)
    .where(
      and(eq(actorRoles.userId, userId), eq(actorRoles.kind, "admin")),
    );
  if (!savedRole)
    await tx.insert(actorRoles).values({
      id: newId("role"),
      userId,
      kind: "admin",
    });
}

async function assertNoMarketplaceProfiles(
  tx: Tx,
  userId: string,
): Promise<void> {
  const [performer] = await tx
    .select({ id: performers.id })
    .from(performers)
    .where(eq(performers.ownerUserId, userId))
    .limit(1);
  const [venue] = await tx
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.ownerUserId, userId))
    .limit(1);
  const [tech] = await tx
    .select({ id: techs.id })
    .from(techs)
    .where(eq(techs.ownerUserId, userId))
    .limit(1);
  if (performer || venue || tech) {
    throw new Error(
      `reserved no-commitment account ${userId} unexpectedly owns a profile`,
    );
  }
}

async function ensureLifecycleAttempt(
  d: Db,
  attempt: LifecycleAttempt,
  attemptIndex: number,
  now: Date,
): Promise<{
  adminUserId: string;
  slotId: string;
  venueId: string;
  venueUserId: string;
}> {
  return d.transaction(async (tx) => {
    // The venue name is the durable reset key. Account deactivation removes
    // the login email, but intentionally keeps the profile/history row, so a
    // later seed run can restore this browser-only fixture without duplicates.
    const [savedVenue] = await tx
      .select({ id: venues.id, ownerUserId: venues.ownerUserId })
      .from(venues)
      .where(eq(venues.name, attempt.venue.name))
      .orderBy(asc(venues.createdAt), asc(venues.id))
      .limit(1);
    const venueUserId = await ensureResettableUser(
      tx,
      attempt.venue.email,
      savedVenue?.ownerUserId,
    );
    const venueId = savedVenue?.id ?? newId("venue");
    const venueValues = {
      ownerUserId: venueUserId,
      kind: attempt.venue.kind,
      name: attempt.venue.name,
      bio: attempt.venue.bio,
      metro: attempt.venue.metro,
      addressLine1: attempt.venue.addressLine1,
      city: attempt.venue.city,
      region: attempt.venue.region,
      postalCode: attempt.venue.postalCode,
      timeZone: attempt.venue.timeZone,
      lat: attempt.venue.lat,
      lng: attempt.venue.lng,
      capacity: attempt.venue.capacity,
      paInventory: { ...attempt.venue.paInventory },
      noiseCurfew: attempt.venue.noiseCurfew,
      status: "live",
    };
    if (savedVenue)
      await tx
        .update(venues)
        .set(venueValues)
        .where(eq(venues.id, venueId));
    else
      await tx.insert(venues).values({
        id: venueId,
        ...venueValues,
      });

    const adminUserId = await ensureResettableUser(tx, attempt.admin.email);
    await ensureAdminRole(tx, adminUserId);

    const [savedSlot] = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(
        and(
          eq(slots.venueId, venueId),
          eq(slots.notes, attempt.slot.marker),
        ),
      )
      .orderBy(asc(slots.createdAt), asc(slots.id))
      .limit(1);
    const slotId = savedSlot?.id ?? newId("slot");
    // Separate retry fixtures by an hour while keeping both comfortably in
    // the future for local runs near a daylight-saving boundary.
    const startsAt = new Date(
      now.getTime() + 21 * 86_400_000 + attemptIndex * 3_600_000,
    );
    const slotValues = {
      venueId,
      metro: attempt.venue.metro,
      startsAt,
      durationMinutes: attempt.slot.durationMinutes,
      format: "music",
      genrePrefs: ["account lifecycle e2e"],
      budgetCents: attempt.slot.amountCents,
      provides: { pa: true },
      notes: attempt.slot.marker,
      status: "open",
      source: "web",
    };
    if (savedSlot)
      await tx
        .update(slots)
        .set(slotValues)
        .where(eq(slots.id, slotId));
    else
      await tx.insert(slots).values({
        id: slotId,
        ...slotValues,
      });

    return { adminUserId, slotId, venueId, venueUserId };
  });
}

async function ensureNoCommitmentDeactivationAttempt(
  d: Db,
  attempt: DeactivationAttempt,
): Promise<void> {
  await d.transaction(async (tx) => {
    const accountUserId = await ensureReservedUser(tx, attempt.account);
    await assertNoMarketplaceProfiles(tx, accountUserId);
    const adminUserId = await ensureReservedUser(tx, attempt.admin);
    await ensureAdminRole(tx, adminUserId);
  });
}

/** Reset both retry-safe account-lifecycle browser fixtures. */
export async function ensureAccountLifecycleE2EJourneys(
  d: Db,
  now = new Date(),
) {
  const results = [];
  for (const [index, attempt] of E2E_JOURNEYS.lifecycle.attempts.entries())
    results.push(await ensureLifecycleAttempt(d, attempt, index, now));
  for (const attempt of E2E_JOURNEYS.lifecycle.deactivationAttempts)
    await ensureNoCommitmentDeactivationAttempt(d, attempt);
  return results;
}
