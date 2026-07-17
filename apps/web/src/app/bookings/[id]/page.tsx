import { TERMINAL_STATES, renderAgreement, soundPlan } from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import { db, findRebookTarget, paymentsEnabled, schema } from "@gigit/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { performerOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDate,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

const BOOKING_STATE_LABELS: Record<string, string> = {
  offered: "Offer awaiting response",
  confirming: "Confirming booking",
  confirmed: "Confirmed",
  awaiting_confirmation: "Gig played — awaiting confirmation",
  released: "Completed",
  collapsed: "Offer closed",
  disputed: "Under review",
  cancelled_by_venue: "Cancelled by venue",
  cancelled_by_performer: "Cancelled by act",
  refunded: "Cancelled and refunded",
  partially_released: "Resolved",
};

const SOUND_STATE_LABELS: Record<string, string> = {
  open: "Open",
  booked: "Tech booked",
  released: "Completed",
  cancelled_by_payer: "Cancelled",
  cancelled_with_parent: "Cancelled with gig",
};

const SOUND_APPLICATION_LABELS: Record<string, string> = {
  submitted: "Application received",
  booked: "Booked",
  declined: "Not selected",
};

const GEAR_LABELS: Record<string, string> = {
  none: "Labor only",
  partial: "Partial rig",
  full_rig: "Full PA rig",
};

const PARTY_LABELS: Record<string, string> = {
  venue: "venue",
  performer: "act",
};

function friendlyLabel(labels: Record<string, string>, value: string) {
  return labels[value] ?? value.replaceAll("_", " ");
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> first.
      </div>
    );
  const d = db();
  const [row] = await d
    .select({
      booking: schema.bookings,
      venueName: schema.venues.name,
      venueAddressLine1: schema.venues.addressLine1,
      venueAddressLine2: schema.venues.addressLine2,
      venueCity: schema.venues.city,
      venueRegion: schema.venues.region,
      venuePostalCode: schema.venues.postalCode,
      venueTimeZone: schema.venues.timeZone,
      performerName: schema.performers.name,
      paInventory: schema.venues.paInventory,
      techNeeds: schema.performers.techNeeds,
    })
    .from(schema.bookings)
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.bookings.id, id));
  if (!row) notFound();
  const b = row.booking;

  const [performer, venue] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
  ]);
  const asPerformer = performer?.id === b.performerId;
  const asVenue = venue?.id === b.venueId;
  if (!asPerformer && !asVenue) notFound();

  const state = b.state as BookingState;
  const terminal = TERMINAL_STATES.has(state);
  const myRole = asVenue ? "venue" : "performer";
  const dealTimeZone = b.terms.timeZone ?? row.venueTimeZone;
  const venueAddress =
    b.terms.venueAddress ??
    formatAddress({
      addressLine1: row.venueAddressLine1,
      addressLine2: row.venueAddressLine2,
      city: row.venueCity,
      region: row.venueRegion,
      postalCode: row.venuePostalCode,
    });
  const offerDateTime = formatVenueDateTime(
    b.terms.startsAt,
    dealTimeZone,
    "full",
  );
  const acceptConfirmation =
    `Accept this firm offer? ${row.performerName} at ${row.venueName} / ${offerDateTime} / ${venueAddress} / $${(b.terms.amountCents / 100).toFixed(0)}. This creates a binding booking.`;

  // Recurring-series re-book (PRD F2.2): one-tap re-offer of this act into the
  // next open series night, at the same pay — the residency anti-leakage hook.
  const rebookTarget = asVenue ? await findRebookTarget(id) : null;

  // Tech sub-slots on this booking (PRD F6.2/F6.3)
  const subslots = await d
    .select()
    .from(schema.techSubslots)
    .where(eq(schema.techSubslots.bookingId, id));
  const activeSubslot = subslots.find((s) => s.state === "open" || s.state === "booked");
  const subslotApplicants = activeSubslot
    ? await d
        .select({ application: schema.techSubslotApplications, tech: schema.techs })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techs, eq(schema.techSubslotApplications.techId, schema.techs.id))
        .where(
          and(
            eq(schema.techSubslotApplications.subslotId, activeSubslot.id),
            inArray(schema.techSubslotApplications.status, ["submitted", "booked"]),
          ),
        )
    : [];
  const plan = soundPlan(row.paInventory, row.techNeeds);
  const amPayer =
    activeSubslot &&
    (activeSubslot.payer === "venue" ? asVenue : asPerformer);

  // Contact reveal at confirmation (PRD F5.1): day-of phones, not before.
  const contactsRevealed = state === "confirmed" || state === "awaiting_confirmation";
  let contacts: { role: string; name: string; phone: string | null; email: string | null }[] = [];
  if (contactsRevealed) {
    const [venueOwner] = await d
      .select({ phone: schema.users.phone, email: schema.users.email })
      .from(schema.venues)
      .innerJoin(schema.users, eq(schema.venues.ownerUserId, schema.users.id))
      .where(eq(schema.venues.id, b.venueId));
    const [performerOwner] = await d
      .select({ phone: schema.users.phone, email: schema.users.email })
      .from(schema.performers)
      .innerJoin(schema.users, eq(schema.performers.ownerUserId, schema.users.id))
      .where(eq(schema.performers.id, b.performerId));
    contacts = [
      {
        role: "Venue",
        name: row.venueName,
        phone: venueOwner?.phone ?? null,
        email: venueOwner?.email ?? null,
      },
      {
        role: "Act",
        name: row.performerName,
        phone: performerOwner?.phone ?? null,
        email: performerOwner?.email ?? null,
      },
    ];
  }
  const [myReview] = await d
    .select()
    .from(schema.reviews)
    .where(
      and(eq(schema.reviews.bookingId, id), eq(schema.reviews.authorRole, myRole)),
    );

  return (
    <div>
      <div className="card">
        <h1>
          {row.performerName} at {row.venueName} <span className="badge">
            {friendlyLabel(BOOKING_STATE_LABELS, state)}
          </span>
        </h1>
        <p>
          {formatVenueDateTime(b.terms.startsAt, dealTimeZone, "full")}{" "}
          {shortTimeZoneName(b.terms.startsAt, dealTimeZone)}{" "}
          / <span className="money">${(b.terms.amountCents / 100).toFixed(0)}</span>
        </p>
        <p className="muted">
          {venueAddress}
        </p>
        {state === "offered" && (
          <p>
            <strong>Firm offer.</strong>{" "}
            <span className="muted">
              Respond by{" "}
              {formatVenueDateTime(b.offerExpiresAt, dealTimeZone)}{" "}
              {shortTimeZoneName(b.offerExpiresAt, dealTimeZone)}. The
              venue cannot offer this night to another act while this offer is
              live.
            </span>
          </p>
        )}
        <p>
          {state === "offered" && asVenue && (
            <ActionButton
              endpoint={`/api/bookings/${id}/cancel`}
              label="Withdraw firm offer"
              confirm="Withdraw this firm offer? The act will be notified and you can then offer the date to someone else."
            />
          )}{" "}
          {state === "confirmed" && (
            <>
              <ActionButton
                endpoint={`/api/bookings/${id}/cancel`}
                label="Cancel booking"
                confirm={
                  asVenue
                    ? "Cancel this booking? The date reopens. " +
                      (paymentsEnabled()
                        ? "Per the agreement, the closer to the date the more of the act's fee is owed."
                        : "Settle anything already arranged with the act directly — EightGig does not process gig payments during beta.")
                    : "Cancel this booking? The date reopens for the venue, and a cancellation counts against your reliability."
                }
              />{" "}
              <span className="muted">
                {asVenue
                  ? paymentsEnabled()
                    ? "Reopens the date; per the agreement you owe more of the fee the closer to the date."
                    : "Reopens the date; settle anything arranged with the act directly."
                  : "Reopens the date; counts against your reliability. No fee owed."}
              </span>
            </>
          )}{" "}
          {state === "awaiting_confirmation" && asPerformer && (
            <ActionButton
              endpoint={`/api/bookings/${id}/mark-played`}
              label="Mark gig as played"
            />
          )}{" "}
          {state === "awaiting_confirmation" && asVenue && (
            <>
              <ActionButton
                endpoint={`/api/bookings/${id}/confirm`}
                label={paymentsEnabled() ? "Confirm & release pay" : "Confirm it played"}
              />{" "}
              <span className="muted">
                {paymentsEnabled()
                  ? "Or the pay releases automatically 24 hours after the set ends, unless you open a dispute."
                  : "Or this auto-confirms 24 hours after the set ends, unless you open a dispute. You and the act settle pay directly."}
              </span>
            </>
          )}
        </p>
        {state === "awaiting_confirmation" && (
          <>
            <p className="muted">
              Something go wrong? Opening a dispute{" "}
              {paymentsEnabled() ? "pauses the payout" : "flags it for review"}. A person
              looks at it within 5 business days.
            </p>
            <ApiForm
              endpoint={`/api/bookings/${id}/dispute`}
              submitLabel="Open a dispute"
              fields={[
                { name: "category", label: "Issue", type: "select", options: ["no_show", "venue_unavailable", "misrepresentation", "other"], required: true },
                { name: "reason", label: "What happened?", type: "textarea", required: true },
              ]}
            />
          </>
        )}
      </div>

      {(state === "offered" || state === "confirmed") && !activeSubslot && (
        <div className="card">
          <h2>Sound</h2>
          <p>
            <span className="badge">
              {plan.verdict === "covered"
                ? "covered by house PA"
                : plan.verdict === "tech_needed"
                  ? "tech needed"
                  : "tech + rig needed"}
            </span>
            {plan.gaps.length > 0 && (
              <span className="muted"> / {plan.gaps.join("; ")}</span>
            )}
          </p>
          {state === "offered" && plan.verdict !== "covered" && (
            <p className="muted">
              This is the current sound plan for the deal. Confirm who brings
              the missing equipment or tech before accepting.
            </p>
          )}
          {state === "confirmed" && plan.verdict !== "covered" && (
            <>
              <p className="muted">
                Post a sound job for this night — techs see the room, the
                input list, and the pay before they say yes.
              </p>
              <ApiForm
                endpoint={`/api/bookings/${id}/tech-subslot`}
                submitLabel="Post the sound job"
                fields={[
                  { name: "payer", label: "Who pays the tech", type: "select", options: ["venue", "performer"], required: true },
                  { name: "budgetCents", label: "Tech pay (USD)", type: "number", required: true, placeholder: "250" },
                  { name: "notes", label: "Anything the tech should know", type: "textarea" },
                ]}
              />
            </>
          )}
        </div>
      )}

      {activeSubslot && (
        <div className="card">
          <h2>Sound</h2>
          <p>
            <span className="badge">
              {friendlyLabel(SOUND_STATE_LABELS, activeSubslot.state)}
            </span>{" "}
            <span className="money">
              ${(activeSubslot.budgetCents / 100).toFixed(0)}
            </span>{" "}
            <span className="muted">
              / paid by the {friendlyLabel(PARTY_LABELS, activeSubslot.payer)}
            </span>
          </p>
          {activeSubslot.needs.gaps.length > 0 && (
            <p className="muted">Gaps: {activeSubslot.needs.gaps.join("; ")}</p>
          )}
          {subslotApplicants.map(({ application, tech }) => (
            <p key={application.id}>
              <strong>{tech.name}</strong>{" "}
              <span className="badge">{friendlyLabel(GEAR_LABELS, tech.gear)}</span>{" "}
              <span className="badge">
                {friendlyLabel(SOUND_APPLICATION_LABELS, application.status)}
              </span>
              {application.note && <span className="muted"> / “{application.note}”</span>}{" "}
              {amPayer && activeSubslot.state === "open" && application.status === "submitted" && (
                <ActionButton
                  endpoint={`/api/tech-subslots/${activeSubslot.id}/book`}
                  label="Book this tech"
                  body={{ techId: tech.id }}
                />
              )}
            </p>
          ))}
          {activeSubslot.state === "open" && subslotApplicants.length === 0 && (
            <p className="muted">
              No techs have applied yet — this appears with their open sound gigs.
            </p>
          )}
          {amPayer && (
            <ActionButton
              endpoint={`/api/tech-subslots/${activeSubslot.id}/cancel`}
              label="Cancel sound job"
              confirm="Cancel this sound job? Any booked tech will be notified and the listing will close."
            />
          )}
        </div>
      )}

      {contactsRevealed && (
        <div className="card">
          <h2>Day-of contacts</h2>
          <p className="muted">
            Shared at confirmation so nobody is hunting for a number at load-in.
          </p>
          {contacts.map((c) => (
            <p key={c.role}>
              <span className="badge">{c.role}</span> <strong>{c.name}</strong>
              {c.phone && <> / {c.phone}</>}
              {c.email && <> / {c.email}</>}
            </p>
          ))}
        </div>
      )}

      {terminal && !myReview && (
        <div className="card">
          <h2>Leave a review</h2>
          <p className="muted">
            Reviews go both ways and publish together — once you&apos;ve both
            written one, or after 7 days. Say it straight.
          </p>
          <ApiForm
            endpoint={`/api/bookings/${id}/review`}
            submitLabel="Submit review"
            transform="ratingsMulti"
            fields={[
              { name: "overall", label: "Overall (1–5)", type: "number", required: true },
              ...(myRole === "venue"
                ? [
                    { name: "draw", label: "Draw — did people come? (1–5)", type: "number" as const },
                    { name: "professionalism", label: "Professionalism (1–5)", type: "number" as const },
                    { name: "quality", label: "Performance quality (1–5)", type: "number" as const },
                  ]
                : [
                    { name: "hospitality", label: "Hospitality (1–5)", type: "number" as const },
                    { name: "accuracy", label: "Room as described? (1–5)", type: "number" as const },
                    { name: "payment", label: "Payment & terms (1–5)", type: "number" as const },
                  ]),
              { name: "body", label: "Comments", type: "textarea" as const },
            ]}
          />
        </div>
      )}
      {myReview && (
        <div className="card muted">You reviewed this booking (★ {myReview.ratings.overall}).</div>
      )}

      {rebookTarget && (
        <div className="card">
          <p>
            Liked working with {row.performerName}?{" "}
            <ActionButton
              endpoint={`/api/bookings/${id}/rebook`}
              label={`Book them again — ${formatVenueDate(
                rebookTarget.startsAt,
                dealTimeZone,
              )}`}
              confirm={`Send a firm offer to ${row.performerName} for ${formatVenueDate(rebookTarget.startsAt, dealTimeZone)} at $${(rebookTarget.amountCents / 100).toFixed(0)}?`}
            />
          </p>
          <p className="muted">
            Send {row.performerName} an offer for your next recurring night at the
            same pay (${(rebookTarget.amountCents / 100).toFixed(0)}).
          </p>
        </div>
      )}

      <div className="card">
        <h2>The deal, in writing</h2>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
          {renderAgreement({
            venueName: row.venueName,
            performerName: row.performerName,
            terms: b.terms,
            paymentsEnabled: paymentsEnabled(),
            templateVersion: b.agreementTemplateVer,
          })}
        </pre>
        {state === "offered" && asPerformer && (
          <div>
            <p>
              Review the complete deal above. Accepting confirms the venue,
              date, address, duration, pay, sound expectations, and any notes
              as a binding booking.
            </p>
            <ActionButton
              endpoint={`/api/bookings/${id}/accept`}
              label="Accept this firm offer"
              body={{ acceptedTerms: true }}
              confirm={acceptConfirmation}
            />{" "}
            <ActionButton
              endpoint={`/api/bookings/${id}/cancel`}
              label="Decline this offer"
              confirm="Decline this firm offer? The venue will be notified and can offer the date to another act."
            />
          </div>
        )}
        <p className="muted">
          Venue accepted: {" "}
          {b.venueAcceptedAt
            ? formatVenueDateTime(b.venueAcceptedAt, dealTimeZone)
            : "Not yet"}{" "}
          · Act accepted: {" "}
          {b.performerAcceptedAt
            ? formatVenueDateTime(b.performerAcceptedAt, dealTimeZone)
            : "Not yet"}
        </p>
      </div>
    </div>
  );
}
