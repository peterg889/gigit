import {
  ACTIVE_BOOKING_STATES,
  AGREEMENT_TEMPLATE_VERSION,
  decide,
  IllegalTransitionError,
  InvalidResolutionError,
  offerCreatedEffects,
  newId,
  SLOT_HOLDING_BOOKING_STATES,
  type BookingEvent,
  type BookingSnapshot,
  type BookingTerms,
  type Effect,
} from "@gigit/domain";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { lockActiveProfileOwners } from "./account-gate.js";
import { declinePendingApplications } from "./application-decline.js";
import { ensureBookingThreadInTx } from "./booking-thread.js";
import { appendEvent } from "./events.js";
import { recordLedgerEntry } from "./ledger.js";
import {
  applications,
  bookings,
  events as eventRows,
  performers,
  slots,
  venues,
} from "./schema.js";

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
export class PaymentReferenceConflictError extends Error {
  readonly code = "payment_reference_conflict";
  constructor(
    readonly bookingId: string,
    readonly existingRef: string,
    readonly incomingRef: string,
  ) {
    super(
      `booking ${bookingId} already references ${existingRef}, not ${incomingRef}`,
    );
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

export interface BookingTransitionLifecycleHooks {
  /** @internal Deterministic seam for booking/resource lock-order tests. */
  afterBookingLock?: () => Promise<void>;
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
  existingTx?: Tx,
  lifecycleHooks: BookingTransitionLifecycleHooks = {},
): Promise<TransitionResult> {
  const apply = async (tx: Tx) => {
    if (event.kind === "PERFORMER_ACCEPTED") {
      // Discover immutable party IDs without taking the booking lock, then
      // serialize with suspension/deactivation before the resource lock. An
      // acceptance must not create payment work for an inactive party.
      const [parties] = await tx
        .select({
          performerId: bookings.performerId,
          venueId: bookings.venueId,
        })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      if (!parties) throw new BookingNotFoundError(bookingId);
      await lockActiveProfileOwners(tx, {
        performerIds: [parties.performerId],
        venueIds: [parties.venueId],
        additionalUserIds: [actor],
      });
    }
    const [row] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update");
    if (!row) throw new BookingNotFoundError(bookingId);
    await lifecycleHooks.afterBookingLock?.();

    const incomingPaymentRef =
      event.kind === "PAYMENT_SUCCEEDED" && event.paymentRef
        ? event.paymentRef
        : undefined;
    if (
      incomingPaymentRef &&
      row.paymentRef &&
      row.paymentRef !== incomingPaymentRef
    )
      throw new PaymentReferenceConflictError(
        bookingId,
        row.paymentRef,
        incomingPaymentRef,
      );
    // The webhook can beat StripeGateway.charge's post-create UPDATE. Resolve
    // the provider reference while this booking row is locked, then persist it
    // with the transition and ledger entry in this same transaction.
    const successfulPaymentRef = incomingPaymentRef ?? row.paymentRef ?? undefined;

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
      const startsAt = new Date(snapshot.terms.startsAt).getTime();
      // Legacy close-in offers could have an expiry after downbeat. Treat the
      // gig itself as the hard deadline even before those rows are swept.
      if (
        now.getTime() >= row.offerExpiresAt.getTime() ||
        !Number.isFinite(startsAt) ||
        now.getTime() >= startsAt
      )
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
            inArray(bookings.state, [...ACTIVE_BOOKING_STATES]),
            sql`(${bookings.terms}->>'startsAt')::timestamptz < ${snapshot.terms.endsAt}::timestamptz`,
            sql`(${bookings.terms}->>'endsAt')::timestamptz > ${snapshot.terms.startsAt}::timestamptz`,
          ),
        )
        .limit(1);
      if (overlap)
        throw new PerformerUnavailableError(row.performerId, overlap.id);
    }

    // A payment provider can complete after downbeat even though acceptance was
    // timely. Close that race immediately: record the successful charge and a
    // compensating full refund in this transaction, collapse the booking, and
    // let the outbox execute the refund. Throwing here left `confirming` stuck
    // for 24 hours while real money could already have moved.
    let latePaymentShouldResolveSlot = false;
    let paymentArrivedTooLate = false;
    let compensatingCollapsedPayment = false;
    if (
      event.kind === "PAYMENT_SUCCEEDED" &&
      snapshot.state === "collapsed" &&
      successfulPaymentRef
    ) {
      // The reconcile sweep can close a pending payment at downbeat just before
      // Stripe delivers success. Only resurrect PAYMENT_SUCCEEDED processing
      // when durable history proves this booking collapsed FROM confirming for
      // that specific timeout/window reason and has a real provider reference.
      // An arbitrary declined/expired offer in `collapsed` must stay illegal.
      const [paymentWindowCollapse] = await tx
        .select({ id: eventRows.id })
        .from(eventRows)
        .where(
          and(
            eq(eventRows.kind, "booking.transition"),
            eq(eventRows.subjectType, "booking"),
            eq(eventRows.subjectId, bookingId),
            sql`${eventRows.payload}->>'event' = 'PAYMENT_FAILED'`,
            sql`${eventRows.payload}->>'from' = 'confirming'`,
            sql`${eventRows.payload}->>'to' = 'collapsed'`,
            sql`${eventRows.payload}->>'reason' in
                ('payment_window_closed', 'payment_timeout',
                 'account_deactivated', 'account_suspended')`,
          ),
        )
        .limit(1);
      const [priorCompensation] = await tx
        .select({ id: eventRows.id })
        .from(eventRows)
        .where(
          and(
            eq(eventRows.kind, "booking.transition"),
            eq(eventRows.subjectType, "booking"),
            eq(eventRows.subjectId, bookingId),
            sql`${eventRows.payload}->>'event' = 'PAYMENT_SUCCEEDED'`,
            sql`${eventRows.payload}->>'from' = 'collapsed'`,
            sql`${eventRows.payload}->>'to' = 'collapsed'`,
          ),
        )
        .limit(1);
      compensatingCollapsedPayment =
        !!paymentWindowCollapse && !priorCompensation;
    }
    if (
      event.kind === "PAYMENT_SUCCEEDED" &&
      (snapshot.state === "confirming" || compensatingCollapsedPayment)
    ) {
      if (compensatingCollapsedPayment) {
        // The earlier PAYMENT_FAILED already reopened/expired the slot and
        // resolved its applications. This pass owns money compensation only.
        paymentArrivedTooLate = true;
      } else {
        const [paymentSlot] = await tx
          .select({ status: slots.status, startsAt: slots.startsAt })
          .from(slots)
          .where(eq(slots.id, row.slotId))
          .for("update");
        const termsStart = new Date(snapshot.terms.startsAt).getTime();
        paymentArrivedTooLate =
          !paymentSlot ||
          paymentSlot.status !== "open" ||
          !Number.isFinite(termsStart) ||
          termsStart <= now.getTime() ||
          paymentSlot.startsAt.getTime() <= now.getTime();
        latePaymentShouldResolveSlot =
          !!paymentSlot &&
          (paymentSlot.status === "open" || paymentSlot.status === "expired") &&
          (termsStart <= now.getTime() ||
            paymentSlot.startsAt.getTime() <= now.getTime());
      }
    }

    let decision: ReturnType<typeof decide>;
    if (paymentArrivedTooLate) {
      const effects: Effect[] = [];
      if (latePaymentShouldResolveSlot) effects.push({ kind: "reopen_slot" });
      effects.push(
        { kind: "refund_funds", amountCents: snapshot.terms.amountCents },
        { kind: "notify", template: "payment_late_refunded", to: "both" },
      );
      decision = { next: "collapsed", effects };
    } else {
      decision = decide(snapshot, event, now); // throws IllegalTransitionError
    }

    let updated;
    try {
      updated = await tx
        .update(bookings)
        .set({
          state: decision.next,
          version: row.version + 1,
          ...(event.kind === "PERFORMER_ACCEPTED" ? { performerAcceptedAt: now } : {}),
          ...(event.kind === "PERFORMER_MARKED_PLAYED"
            ? { performerMarkedPlayedAt: now }
            : {}),
          ...(incomingPaymentRef ? { paymentRef: incomingPaymentRef } : {}),
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
        ...(successfulPaymentRef ? { paymentRef: successfulPaymentRef } : {}),
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
        const gigStartsAt = new Date(snapshot.terms.startsAt).getTime();
        const gigHasStarted =
          !Number.isFinite(gigStartsAt) || gigStartsAt <= now.getTime();
        if (gigHasStarted) {
          // A cancellation/decline/expiry after downbeat must never resurrect
          // the night in the feed. Resolve the offered application and any
          // remaining pending applicants instead.
          await tx
            .update(slots)
            .set({ status: "expired" })
            .where(eq(slots.id, row.slotId));
          await tx
            .update(applications)
            .set({
              status:
                event.kind === "PERFORMER_DECLINED" ? "withdrawn" : "declined",
              declineReason:
                event.kind === "PERFORMER_DECLINED" ? null : "slot_expired",
            })
            .where(
              and(
                eq(applications.slotId, row.slotId),
                eq(applications.performerId, row.performerId),
                eq(applications.status, "offered"),
              ),
            );
          await declinePendingApplications(tx, {
            slotIds: [row.slotId],
            actor,
            reason: "slot_expired",
          });
          continue;
        }

        await tx
          .update(slots)
          .set({ status: "open" })
          .where(eq(slots.id, row.slotId));
        // The collapsing offer left this performer's application frozen in
        // 'offered' (createOffer set it). Venue withdrawal/expiry returns it
        // to submitted so the offer can be retried; a performer decline closes
        // their own application as withdrawn — re-applying to the reopened
        // slot revives it (the apply route flips withdrawn back to submitted),
        // so the pairing is never permanently locked out.
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
        // Everyone else was auto-declined when the slot filled. Reopening put
        // the night back on the board but left that whole warm pool frozen:
        // they couldn't re-apply (unique index → 409), the venue couldn't offer
        // them (createOffer requires 'submitted'), and series re-book skipped
        // the night forever — so it could only be filled by an act that had
        // never applied. Revive exactly the passed-over ones; a venue's
        // deliberate decline stays declined.
        const revived = await tx
          .update(applications)
          .set({ status: "submitted", declineReason: null })
          .where(
            and(
              eq(applications.slotId, row.slotId),
              eq(applications.status, "declined"),
              eq(applications.declineReason, "slot_filled"),
              ne(applications.performerId, row.performerId),
            ),
          )
          .returning({ id: applications.id });
        if (revived.length > 0)
          await appendEvent(tx, {
            actor,
            kind: "slot.applicants_revived",
            subjectType: "slot",
            subjectId: row.slotId,
            payload: { count: revived.length, applicationIds: revived.map((r) => r.id) },
          });
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
      const filled = await tx
        .update(slots)
        .set({ status: "filled" })
        .where(
          and(
            eq(slots.id, row.slotId),
            eq(slots.status, "open"),
            gt(slots.startsAt, now),
          ),
        )
        .returning({ id: slots.id });
      if (filled.length === 0) throw new SlotUnavailableError(row.slotId);
      // The losing applicants: decline them AND tell them. This bulk path is
      // the high-volume way an application ends, and it used to emit no event
      // at all — so most acts never heard anything back.
      await declinePendingApplications(tx, {
        slotIds: [row.slotId],
        actor,
        reason: "slot_filled",
        excludePerformerId: row.performerId,
      });
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
        ...(event.kind === "PAYMENT_SUCCEEDED" && successfulPaymentRef
          ? { paymentRef: successfulPaymentRef }
          : {}),
      },
    });

    return {
      bookingId,
      from: snapshot.state,
      to: decision.next,
      effects: decision.effects,
    };
  };
  return existingTx ? apply(existingTx) : db().transaction(apply);
}

export interface CreateOfferInput {
  applicationId: string;
  slotId: string;
  performerId: string;
  venueId: string;
  terms: BookingTerms;
  actor: string;
  offerTtlHours?: number;
  /** @internal Deterministic seam for account-gate integration tests. */
  lifecycleHooks?: {
    afterAccountLock?: () => Promise<void>;
    afterSlotLock?: () => Promise<void>;
  };
}

async function slotHoldingBookingId(
  tx: Tx,
  slotId: string,
): Promise<string | undefined> {
  const [holder] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.slotId, slotId),
        inArray(bookings.state, SLOT_HOLDING_BOOKING_STATES),
      ),
    )
    .limit(1);
  return holder?.id;
}

/**
 * Creates the booking row in `offered` + marks the application, atomically.
 *
 * Callers that must prepare the application in the same unit of work (the
 * venue-initiated invite path) may supply an existing transaction. All other
 * callers retain the usual self-contained transaction.
 */
export async function createOffer(
  input: CreateOfferInput,
  existingTx?: Tx,
): Promise<string> {
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
  const offeredAt = new Date();
  // A live offer holds the slot exclusively, so an unclamped 72h TTL meant a
  // venue posting Wednesday for Friday and offering that night was locked out
  // of every other act until Saturday — 48h AFTER the gig — unless they
  // remembered to withdraw by hand. One unresponsive act killed the night.
  // Never let an offer outlive its own gig: aim for 12h before downbeat and at
  // least an hour to answer, but when a venue is filling a truly close-in slot,
  // downbeat wins as the hard deadline.
  const gigStart = new Date(input.terms.startsAt).getTime();
  const offerExpiresAt = new Date(
    Math.min(
      gigStart,
      Math.max(
        offeredAt.getTime() + 3_600_000,
        Math.min(
          offeredAt.getTime() + offerTtlHours * 3_600_000,
          gigStart - 12 * 3_600_000,
        ),
      ),
    ),
  );
  try {
    const persist = async (tx: Tx) => {
      const activeProfiles = await lockActiveProfileOwners(tx, {
        performerIds: [input.performerId],
        venueIds: [input.venueId],
      });
      await input.lifecycleHooks?.afterAccountLock?.();
      const offerVenue = activeProfiles.venues.get(input.venueId)!;

      // A booking transition owns booking → slot ordering. Looking for a
      // committed holder BEFORE taking the slot prevents this creator from
      // holding slot → waiting on the partial-unique booking entry while the
      // transition holds booking → waiting on this same slot. This read does
      // not lock or wait on the transitioning row; under READ COMMITTED its
      // prior committed live state is enough to conservatively reject.
      if (await slotHoldingBookingId(tx, input.slotId))
        throw new SlotUnavailableError(input.slotId);

      // Lock the advertised slot so edits and competing offers cannot race the
      // terms snapshot. Pay, time, and duration must be exactly what the
      // performer saw on the open slot.
      const [slot] = await tx
        .select()
        .from(slots)
        .where(eq(slots.id, input.slotId))
        .for("update");
      await input.lifecycleHooks?.afterSlotLock?.();
      if (!slot || slot.status !== "open")
        throw new SlotUnavailableError(input.slotId);
      // A competing creator can have committed while this transaction waited
      // for the slot. Recheck before inserting so the unique index remains the
      // last-resort invariant rather than the normal control-flow boundary.
      if (await slotHoldingBookingId(tx, input.slotId))
        throw new SlotUnavailableError(input.slotId);
      // Re-check after acquiring the lock. A close-in slot can cross downbeat
      // while this transaction waits behind an edit or competing offer.
      const persistedAt = new Date();
      if (
        slot.startsAt.getTime() <= persistedAt.getTime() ||
        offerExpiresAt.getTime() <= persistedAt.getTime()
      )
        throw new SlotUnavailableError(input.slotId);

      if (offerVenue.id !== slot.venueId)
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
        venueAcceptedAt: offeredAt,
      });
      await tx
        .update(applications)
        .set({ status: "offered" })
        .where(eq(applications.id, input.applicationId));
      await ensureBookingThreadInTx(tx, bookingId, input.actor);
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
    };
    if (existingTx) await persist(existingTx);
    else await db().transaction(persist);
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
