import {
  AGREEMENT_TEMPLATE_VERSION,
  decide,
  IllegalTransitionError,
  InvalidResolutionError,
  offerCreatedEffects,
  newId,
  type BookingEvent,
  type BookingSnapshot,
  type BookingTerms,
  type Effect,
} from "@gigit/domain";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { recordLedgerEntry } from "./ledger.js";
import { applications, bookings, performers, slots, venues } from "./schema.js";

export class BookingNotFoundError extends Error {
  readonly code = "booking_not_found";
}
export class ConcurrentUpdateError extends Error {
  readonly code = "concurrent_update";
}
export class SlotUnavailableError extends Error {
  readonly code = "slot_unavailable";
  constructor(readonly slotId: string) {
    super(`slot ${slotId} is no longer available`);
  }
}
export class PerformerUnavailableError extends Error {
  readonly code = "performer_unavailable";
  constructor(
    readonly performerId: string,
    readonly conflictingBookingId: string,
  ) {
    super(`performer ${performerId} already has an overlapping booking`);
  }
}
export class InvalidOfferTermsError extends Error {
  readonly code = "invalid_offer_terms";
  constructor(message: string) {
    super(message);
  }
}
export class OfferExpiredError extends Error {
  readonly code = "offer_expired";
  constructor(readonly bookingId: string) {
    super(`offer ${bookingId} has expired`);
  }
}

/** Dig the Postgres SQLSTATE out of a (possibly drizzle-wrapped) error chain. */
export function pgErrorCode(e: unknown): string | undefined {
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 5; i++) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
}
export { IllegalTransitionError, InvalidResolutionError };

export interface TransitionResult {
  bookingId: string;
  from: string;
  to: string;
  effects: Effect[];
}

/**
 * The ONLY way booking state changes (engineering-spec §5).
 * One transaction: row lock → pure domain decision → versioned update →
 * in-tx side effects (slot status, reliability strikes) → outbox event.
 * External effects (notify/schedule/payment) ride in the event payload
 * for the worker to interpret.
 */
export async function runBookingTransition(
  bookingId: string,
  event: BookingEvent,
  actor: string,
  now: Date = new Date(),
): Promise<TransitionResult> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update");
    if (!row) throw new BookingNotFoundError(bookingId);

    const snapshot: BookingSnapshot = {
      id: row.id,
      slotId: row.slotId,
      performerId: row.performerId,
      state: row.state as BookingSnapshot["state"],
      version: row.version,
      terms: row.terms as BookingTerms,
      offerExpiresAt: row.offerExpiresAt.toISOString(),
    };

    if (event.kind === "PERFORMER_ACCEPTED") {
      if (now.getTime() >= row.offerExpiresAt.getTime())
        throw new OfferExpiredError(bookingId);
      // Serialize accepts for this performer, even when two different booking
      // rows are accepted concurrently. Row locks alone only protect one
      // booking; this lock makes the overlap check + transition one atomic
      // decision for the performer calendar.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${row.performerId}))`,
      );
      const [overlap] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.performerId, row.performerId),
            ne(bookings.id, bookingId),
            inArray(bookings.state, [
              "confirming",
              "confirmed",
              "awaiting_confirmation",
              "disputed",
            ]),
            sql`(${bookings.terms}->>'startsAt')::timestamptz < ${snapshot.terms.endsAt}::timestamptz`,
            sql`(${bookings.terms}->>'endsAt')::timestamptz > ${snapshot.terms.startsAt}::timestamptz`,
          ),
        )
        .limit(1);
      if (overlap)
        throw new PerformerUnavailableError(row.performerId, overlap.id);
    }

    const decision = decide(snapshot, event, now); // throws IllegalTransitionError

    let updated;
    try {
      updated = await tx
        .update(bookings)
        .set({
          state: decision.next,
          version: row.version + 1,
          ...(event.kind === "PERFORMER_ACCEPTED" ? { performerAcceptedAt: now } : {}),
        })
        .where(and(eq(bookings.id, bookingId), eq(bookings.version, row.version)))
        .returning({ id: bookings.id });
    } catch (e) {
      // Double-booking guard: the partial unique index on bookings(slot_id) rejects a
      // second booking advancing past 'offered' on the same slot. (23505 may be nested
      // under drizzle's query-error wrapper.) Map to a clean conflict.
      if (pgErrorCode(e) === "23505") throw new SlotUnavailableError(row.slotId);
      throw e;
    }
    if (updated.length === 0) throw new ConcurrentUpdateError(bookingId);

    // Money intents are ledgered atomically with the transition (K3/K5).
    const venueParty = `venue:${row.venueId}`;
    const performerParty = `performer:${row.performerId}`;
    if (event.kind === "PAYMENT_SUCCEEDED") {
      await recordLedgerEntry(tx, {
        bookingId,
        entryType: "charge",
        debitParty: venueParty,
        creditParty: "platform",
        amountCents: snapshot.terms.amountCents,
        ...(row.paymentRef ? { paymentRef: row.paymentRef } : {}),
      });
    }

    // In-transaction side effects the db layer owns:
    for (const fx of decision.effects) {
      if (fx.kind === "release_funds") {
        await recordLedgerEntry(tx, {
          bookingId,
          entryType: "release",
          debitParty: "platform",
          creditParty: performerParty,
          amountCents: fx.amountCents,
        });
      }
      if (fx.kind === "refund_funds") {
        await recordLedgerEntry(tx, {
          bookingId,
          entryType: "refund",
          debitParty: "platform",
          creditParty: venueParty,
          amountCents: fx.amountCents,
        });
      }
      if (fx.kind === "cancellation_fee") {
        await recordLedgerEntry(tx, {
          bookingId,
          entryType: "fee",
          debitParty: "platform",
          creditParty: performerParty,
          amountCents: fx.feeCents,
        });
        await recordLedgerEntry(tx, {
          bookingId,
          entryType: "refund",
          debitParty: "platform",
          creditParty: venueParty,
          amountCents: fx.refundCents,
        });
      }
      if (fx.kind === "reopen_slot") {
        await tx
          .update(slots)
          .set({ status: "open" })
          .where(eq(slots.id, row.slotId));
        // The collapsing offer left this performer's application frozen in
        // 'offered' (createOffer set it). Venue withdrawal/expiry returns it
        // to submitted so the offer can be retried; a performer decline closes
        // their own application as withdrawn.
        await tx
          .update(applications)
          .set({
            status:
              event.kind === "PERFORMER_DECLINED" ? "withdrawn" : "submitted",
          })
          .where(
            and(
              eq(applications.slotId, row.slotId),
              eq(applications.performerId, row.performerId),
              eq(applications.status, "offered"),
            ),
          );
      }
      if (fx.kind === "reliability_strike") {
        if (fx.against === "performer") {
          await tx
            .update(performers)
            .set({ reliabilityStrikes: sql`${performers.reliabilityStrikes} + 1` })
            .where(eq(performers.id, row.performerId));
        } else {
          await tx
            .update(venues)
            .set({ reliabilityStrikes: sql`${venues.reliabilityStrikes} + 1` })
            .where(eq(venues.id, row.venueId));
        }
      }
    }
    // Entering `confirmed` fills the slot and declines the other applicants.
    if (decision.next === "confirmed") {
      await tx
        .update(slots)
        .set({ status: "filled" })
        .where(eq(slots.id, row.slotId));
      await tx
        .update(applications)
        .set({ status: "declined" })
        .where(
          and(
            eq(applications.slotId, row.slotId),
            ne(applications.performerId, row.performerId),
            eq(applications.status, "submitted"),
          ),
        );
    }

    await appendEvent(tx, {
      actor,
      kind: "booking.transition",
      subjectType: "booking",
      subjectId: bookingId,
      payload: {
        event: event.kind,
        from: snapshot.state,
        to: decision.next,
        effects: decision.effects,
        // Carry the originating event's context into the event log — the
        // dispute brief (ai.ts) and admin adjudication read events.payload, so
        // dropping these would leave the human resolving a dispute with no
        // "who opened it" and no reason at all.
        ...(event.kind === "DISPUTE_OPENED"
          ? { openedBy: event.openedBy, reason: event.reason }
          : {}),
        ...(event.kind === "PAYMENT_FAILED" && event.reason
          ? { reason: event.reason }
          : {}),
      },
    });

    return {
      bookingId,
      from: snapshot.state,
      to: decision.next,
      effects: decision.effects,
    };
  });
}

export interface CreateOfferInput {
  applicationId: string;
  slotId: string;
  performerId: string;
  venueId: string;
  terms: BookingTerms;
  actor: string;
  offerTtlHours?: number;
}

/** Creates the booking row in `offered` + marks the application, atomically. */
export async function createOffer(input: CreateOfferInput): Promise<string> {
  // A money-releasing timer (gig_ended -> auto_confirm) is scheduled off endsAt,
  // so it must be after startsAt. Guard the invariant at the single entry point.
  const startsAtMs = new Date(input.terms.startsAt).getTime();
  const endsAtMs = new Date(input.terms.endsAt).getTime();
  if (
    !Number.isFinite(startsAtMs) ||
    !Number.isFinite(endsAtMs) ||
    endsAtMs <= startsAtMs
  )
    throw new InvalidOfferTermsError(
      "invalid booking terms: endsAt must be after startsAt",
    );

  const offerTtlHours = input.offerTtlHours ?? 72;
  if (!Number.isFinite(offerTtlHours) || offerTtlHours <= 0)
    throw new InvalidOfferTermsError("offer TTL must be positive");
  const bookingId = newId("booking");
  const offerExpiresAt = new Date(
    Date.now() + offerTtlHours * 3_600_000,
  );
  try {
    await db().transaction(async (tx) => {
      // Lock the advertised slot so edits and competing offers cannot race the
      // terms snapshot. Pay, time, and duration must be exactly what the
      // performer saw on the open slot.
      const [slot] = await tx
        .select()
        .from(slots)
        .where(eq(slots.id, input.slotId))
        .for("update");
      if (!slot || slot.status !== "open")
        throw new SlotUnavailableError(input.slotId);

      const [offerVenue] = await tx
        .select()
        .from(venues)
        .where(eq(venues.id, input.venueId));
      if (!offerVenue || offerVenue.id !== slot.venueId)
        throw new InvalidOfferTermsError("venue does not match the slot");
      const locality = [
        [offerVenue.city, offerVenue.region].filter(Boolean).join(", "),
        offerVenue.postalCode,
      ]
        .filter(Boolean)
        .join(" ");
      const venueAddress = [
        offerVenue.addressLine1,
        offerVenue.addressLine2,
        locality,
      ]
        .filter(Boolean)
        .join(", ");
      if (
        input.terms.venueAddress !== undefined &&
        input.terms.venueAddress !== venueAddress
      )
        throw new InvalidOfferTermsError(
          "offer address must match the venue profile",
        );
      if (
        input.terms.timeZone !== undefined &&
        input.terms.timeZone !== offerVenue.timeZone
      )
        throw new InvalidOfferTermsError(
          "offer timezone must match the venue profile",
        );
      const lockedTerms: BookingTerms = {
        ...input.terms,
        venueAddress,
        timeZone: offerVenue.timeZone,
      };

      const [application] = await tx
        .select()
        .from(applications)
        .where(eq(applications.id, input.applicationId))
        .for("update");
      if (
        !application ||
        application.status !== "submitted" ||
        application.slotId !== input.slotId ||
        application.performerId !== input.performerId ||
        slot.venueId !== input.venueId
      )
        throw new InvalidOfferTermsError(
          "the application is no longer eligible for this slot",
        );

      const advertisedEndsAt = new Date(
        slot.startsAt.getTime() + slot.durationMinutes * 60_000,
      );
      if (input.terms.amountCents !== slot.budgetCents)
        throw new InvalidOfferTermsError(
          `offer amount must match the advertised $${(slot.budgetCents / 100).toFixed(2)}`,
        );
      if (
        startsAtMs !== slot.startsAt.getTime() ||
        endsAtMs !== advertisedEndsAt.getTime()
      )
        throw new InvalidOfferTermsError(
          "offer time and duration must match the advertised slot",
        );
      const offeredProvides = input.terms.provides ?? {};
      const advertisedProvides = slot.provides ?? {};
      if (
        offeredProvides.pa !== advertisedProvides.pa ||
        offeredProvides.meal !== advertisedProvides.meal ||
        offeredProvides.parking !== advertisedProvides.parking
      )
        throw new InvalidOfferTermsError(
          "offer provisions must match the advertised slot",
        );
      if (
        slot.notes &&
        !input.terms.notes?.includes(slot.notes)
      )
        throw new InvalidOfferTermsError(
          "offer notes must include the advertised slot notes",
        );

      if (
        input.terms.setLengthMinutes !== undefined &&
        input.terms.setLengthMinutes > slot.durationMinutes
      )
        throw new InvalidOfferTermsError(
          "set length cannot exceed the advertised slot duration",
        );

      await tx.insert(bookings).values({
        id: bookingId,
        slotId: input.slotId,
        performerId: input.performerId,
        venueId: input.venueId,
        state: "offered",
        terms: lockedTerms,
        offerExpiresAt,
        agreementTemplateVer: AGREEMENT_TEMPLATE_VERSION,
        venueAcceptedAt: new Date(),
      });
      await tx
        .update(applications)
        .set({ status: "offered" })
        .where(eq(applications.id, input.applicationId));
      await appendEvent(tx, {
        actor: input.actor,
        kind: "booking.offered",
        subjectType: "booking",
        subjectId: bookingId,
        payload: {
          slotId: input.slotId,
          performerId: input.performerId,
          terms: { ...lockedTerms },
          agreementTemplateVersion: AGREEMENT_TEMPLATE_VERSION,
          effects: offerCreatedEffects(offerExpiresAt.toISOString()),
        },
      });
    });
  } catch (e) {
    // The partial unique index includes 'offered', so only one firm offer may
    // be outstanding for a slot. Keep this mapping at the persistence edge so
    // concurrent HTTP requests get the same conflict as sequential ones.
    if (pgErrorCode(e) === "23505")
      throw new SlotUnavailableError(input.slotId);
    throw e;
  }
  return bookingId;
}
