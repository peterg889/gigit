import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  applications,
  performers,
  slots,
  venues,
} from "./schema.js";
import { E2E_JOURNEYS } from "./seed-fixtures.js";
import { ensureActiveSeedUser } from "./seed-postgig.js";

type AgedSlotAttempt = (typeof E2E_JOURNEYS.aged.attempts)[number];

async function ensureAgedSlotAttempt(
  d: Db,
  attempt: AgedSlotAttempt,
  attemptIndex: number,
  now: Date,
): Promise<{
  applicationId: string;
  performerId: string;
  performerUserId: string;
  slotId: string;
  venueId: string;
  venueUserId: string;
}> {
  return d.transaction(async (tx) => {
    const venueUserId = await ensureActiveSeedUser(tx, attempt.venue.email);
    const [savedVenue] = await tx
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.ownerUserId, venueUserId));
    const venueId = savedVenue?.id ?? newId("venue");
    const venueValues = {
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
      await tx.update(venues).set(venueValues).where(eq(venues.id, venueId));
    else
      await tx.insert(venues).values({
        id: venueId,
        ownerUserId: venueUserId,
        ...venueValues,
      });

    const performerUserId = await ensureActiveSeedUser(
      tx,
      attempt.performer.email,
    );
    const [savedPerformer] = await tx
      .select({ id: performers.id })
      .from(performers)
      .where(eq(performers.ownerUserId, performerUserId));
    const performerId = savedPerformer?.id ?? newId("performer");
    const performerValues = {
      kind: attempt.performer.kind,
      name: attempt.performer.name,
      bio: attempt.performer.bio,
      genreTags: [...attempt.performer.genreTags],
      homeMetro: attempt.performer.homeMetro,
      travelRadiusMiles: attempt.performer.travelRadiusMiles,
      rateMinCents: attempt.performer.rateMinCents,
      rateMaxCents: attempt.performer.rateMaxCents,
      setLengthsMinutes: [...attempt.performer.setLengthsMinutes],
      techNeeds: { ...attempt.performer.techNeeds },
      status: "live",
    };
    if (savedPerformer)
      await tx
        .update(performers)
        .set(performerValues)
        .where(eq(performers.id, performerId));
    else
      await tx.insert(performers).values({
        id: performerId,
        ownerUserId: performerUserId,
        ...performerValues,
      });

    // Keep the fixture comfortably behind the boundary. The second attempt is
    // one hour older, making retries distinct without any wall-clock races.
    const startsAt = new Date(
      now.getTime() - (24 + attemptIndex) * 3_600_000,
    );
    const [savedSlot] = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(eq(slots.id, attempt.slot.id));
    const slotValues = {
      venueId,
      metro: attempt.venue.metro,
      startsAt,
      durationMinutes: attempt.slot.durationMinutes,
      format: "music",
      genrePrefs: ["aged date e2e"],
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
        .where(eq(slots.id, attempt.slot.id));
    else
      await tx.insert(slots).values({
        id: attempt.slot.id,
        ...slotValues,
        createdAt: new Date(startsAt.getTime() - 7 * 86_400_000),
      });

    const [savedApplication] = await tx
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, attempt.slot.applicationId));
    const applicationValues = {
      slotId: attempt.slot.id,
      performerId,
      note: attempt.slot.applicationNote,
      status: "submitted",
      declineReason: null,
    };
    if (savedApplication)
      await tx
        .update(applications)
        .set(applicationValues)
        .where(eq(applications.id, attempt.slot.applicationId));
    else
      await tx.insert(applications).values({
        id: attempt.slot.applicationId,
        ...applicationValues,
      });

    return {
      applicationId: attempt.slot.applicationId,
      performerId,
      performerUserId,
      slotId: attempt.slot.id,
      venueId,
      venueUserId,
    };
  });
}

/** Reset both retry-safe past-open-date browser fixtures. */
export async function ensureAgedSlotE2EJourneys(d: Db, now = new Date()) {
  const results = [];
  for (const [index, attempt] of E2E_JOURNEYS.aged.attempts.entries())
    results.push(await ensureAgedSlotAttempt(d, attempt, index, now));
  return results;
}
