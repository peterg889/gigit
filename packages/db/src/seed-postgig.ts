import { AGREEMENT_TEMPLATE_VERSION, newId } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { recordLedgerEntry } from "./ledger.js";
import {
  actorRoles,
  bookings,
  events,
  ledgerEntries,
  performers,
  reviews,
  slots,
  users,
  venues,
} from "./schema.js";
import { E2E_JOURNEYS, performerRow, venueRow } from "./seed-fixtures.js";

type SeedDatabase = Db | Tx;

export async function ensureActiveSeedUser(
  d: SeedDatabase,
  email: string,
): Promise<string> {
  const [existing] = await d
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email));
  if (existing) {
    if (existing.status !== "active")
      await d
        .update(users)
        .set({ status: "active" })
        .where(eq(users.id, existing.id));
    return existing.id;
  }

  const id = newId("user");
  await d.insert(users).values({ id, email });
  return id;
}

/**
 * Reset the one post-gig browser fixture to a deterministic starting point.
 * This data is reserved for E2E only: clearing its reviews/history lets a
 * repeated `db:seed` produce the same awaiting-confirmation journey without
 * touching real demo bookings.
 */
export async function ensurePostGigE2EJourney(
  d: Db,
  now = new Date(),
): Promise<{
  adminUserId: string;
  bookingId: string;
  performerId: string;
  performerUserId: string;
  slotId: string;
  venueId: string;
  venueUserId: string;
}> {
  const journey = E2E_JOURNEYS.postgig;
  return d.transaction(async (tx) => {
    const venueUserId = await ensureActiveSeedUser(tx, journey.venue.email);
    const [savedVenue] = await tx
      .select({ id: venues.id })
      .from(venues)
      .where(
        and(
          eq(venues.ownerUserId, venueUserId),
          eq(venues.status, "live"),
        ),
      );
    const venueValues = venueRow(journey.venue);
    const venueId = savedVenue?.id ?? newId("venue");
    if (savedVenue)
      await tx
        .update(venues)
        .set(venueValues)
        .where(eq(venues.id, venueId));
    else
      await tx.insert(venues).values({
        id: venueId,
        ownerUserId: venueUserId,
        ...venueValues,
      });

    const performerUserId = await ensureActiveSeedUser(
      tx,
      journey.performer.email,
    );
    const [savedPerformer] = await tx
      .select({ id: performers.id })
      .from(performers)
      .where(
        and(
          eq(performers.ownerUserId, performerUserId),
          eq(performers.status, "live"),
        ),
      );
    const performerValues = performerRow(journey.performer);
    const performerId = savedPerformer?.id ?? newId("performer");
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

    const adminUserId = await ensureActiveSeedUser(tx, journey.admin.email);
    const [savedRole] = await tx
      .select({ id: actorRoles.id })
      .from(actorRoles)
      .where(
        and(
          eq(actorRoles.userId, adminUserId),
          eq(actorRoles.kind, "admin"),
        ),
      );
    if (!savedRole)
      await tx.insert(actorRoles).values({
        id: newId("role"),
        userId: adminUserId,
        kind: "admin",
      });

    const durationMs = journey.booking.durationMinutes * 60_000;
    // Past, but still inside the 24-hour auto-confirm/dispute window when the
    // production worker starts alongside Playwright.
    const startsAt = new Date(now.getTime() - 12 * 3_600_000);
    const [savedSlot] = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(
        and(
          eq(slots.venueId, venueId),
          eq(slots.notes, journey.booking.marker),
        ),
      );
    const slotId = savedSlot?.id ?? newId("slot");
    if (savedSlot)
      await tx
        .update(slots)
        .set({
          metro: journey.venue.metro,
          startsAt,
          durationMinutes: journey.booking.durationMinutes,
          format: "music",
          genrePrefs: ["indie rock"],
          budgetCents: journey.booking.amountCents,
          provides: { pa: true, meal: true },
          notes: journey.booking.marker,
          status: "filled",
        })
        .where(eq(slots.id, slotId));
    else
      await tx.insert(slots).values({
        id: slotId,
        venueId,
        metro: journey.venue.metro,
        startsAt,
        durationMinutes: journey.booking.durationMinutes,
        format: "music",
        genrePrefs: ["indie rock"],
        budgetCents: journey.booking.amountCents,
        provides: { pa: true, meal: true },
        notes: journey.booking.marker,
        status: "filled",
        createdAt: new Date(startsAt.getTime() - 7 * 86_400_000),
      });

    const [persistedSlot] = await tx
      .select({ startsAt: slots.startsAt })
      .from(slots)
      .where(eq(slots.id, slotId));
    if (!persistedSlot) throw new Error("post-gig seed slot was not persisted");
    const persistedEndsAt = new Date(
      persistedSlot.startsAt.getTime() + durationMs,
    );
    const terms = {
      amountCents: journey.booking.amountCents,
      startsAt: persistedSlot.startsAt.toISOString(),
      endsAt: persistedEndsAt.toISOString(),
      setLengthMinutes: journey.booking.durationMinutes,
      provides: { pa: true, meal: true },
      notes: journey.booking.marker,
      venueAddress: `${journey.venue.addressLine1}, ${journey.venue.city}, ${journey.venue.region} ${journey.venue.postalCode}`,
      timeZone: journey.venue.timeZone,
    };
    const [savedBooking] = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.slotId, slotId));
    const bookingId = savedBooking?.id ?? newId("booking");
    const acceptedAt = new Date(
      persistedSlot.startsAt.getTime() - 48 * 3_600_000,
    );
    if (savedBooking)
      await tx
        .update(bookings)
        .set({
          performerId,
          venueId,
          state: "awaiting_confirmation",
          version: 4,
          terms,
          offerExpiresAt: new Date(
            persistedSlot.startsAt.getTime() - 12 * 3_600_000,
          ),
          agreementTemplateVer: AGREEMENT_TEMPLATE_VERSION,
          paymentRef: "null_e2e_postgig",
          venueAcceptedAt: new Date(acceptedAt.getTime() - 3_600_000),
          performerAcceptedAt: acceptedAt,
          performerMarkedPlayedAt: null,
        })
        .where(eq(bookings.id, bookingId));
    else
      await tx.insert(bookings).values({
        id: bookingId,
        slotId,
        performerId,
        venueId,
        state: "awaiting_confirmation",
        version: 4,
        terms,
        offerExpiresAt: new Date(
          persistedSlot.startsAt.getTime() - 12 * 3_600_000,
        ),
        agreementTemplateVer: AGREEMENT_TEMPLATE_VERSION,
        paymentRef: "null_e2e_postgig",
        venueAcceptedAt: new Date(acceptedAt.getTime() - 3_600_000),
        performerAcceptedAt: acceptedAt,
        createdAt: new Date(
          persistedSlot.startsAt.getTime() - 7 * 86_400_000,
        ),
      });

    // This booking is a resettable browser fixture, so remove only its prior
    // journey output before restoring the one initial charge intent.
    await tx.delete(reviews).where(eq(reviews.bookingId, bookingId));
    await tx
      .delete(events)
      .where(and(eq(events.subjectType, "booking"), eq(events.subjectId, bookingId)));
    await tx
      .delete(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    await recordLedgerEntry(tx, {
      bookingId,
      entryType: "charge",
      debitParty: `venue:${venueId}`,
      creditParty: "platform",
      amountCents: journey.booking.amountCents,
      paymentRef: "null_e2e_postgig",
    });

    return {
      adminUserId,
      bookingId,
      performerId,
      performerUserId,
      slotId,
      venueId,
      venueUserId,
    };
  });
}
