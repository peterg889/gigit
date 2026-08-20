import {
  ACTIVE_SUBSLOT_STATES,
  AUTO_CONFIRM_HOURS,
  isReviewableBookingState,
  renderAgreement,
  soundPlan,
} from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import {
  bookingThreadId,
  db,
  findRebookTarget,
  paymentsEnabled,
  schema,
} from "@gigit/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isSubslotPayer, profileCapabilitiesOwnedBy } from "@/lib/auth";
import { accountCanAct } from "@/lib/profile-capabilities";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDate,
  formatVenueDateTime,
  formatVenueDateTimeWithZone,
} from "@/lib/date-time";
import {
  bookingContactsAreVisible,
  confirmedCancellationCopy,
} from "@/lib/booking-display";
import { bookingWasConfirmed } from "@/lib/booking-history";
import {
  isSoundApplicantBookable,
  isSoundConsentActionable,
  isSoundJobActionable,
  isPayerSoundCancellationActionable,
  isSoundParentActionable,
  payerSoundCancellationConfirmation,
  soundVerdictClass,
} from "@/lib/sound-display";

export const dynamic = "force-dynamic";

import {
  SOUND_VERDICT_LABELS,
  BOOKING_STATE_LABELS,
  GEAR_LABELS,
  PARTY_LABELS,
  SOUND_APPLICATION_LABELS_REVIEW,
  SOUND_STATE_LABELS,
  friendlyLabel,
} from "@/lib/labels";

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
      venueProfileStatus: schema.venues.status,
      venueOwnerUserId: schema.venues.ownerUserId,
      performerName: schema.performers.name,
      performerProfileStatus: schema.performers.status,
      performerOwnerUserId: schema.performers.ownerUserId,
      paInventory: schema.venues.paInventory,
      techNeeds: schema.performers.techNeeds,
    })
    .from(schema.bookings)
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.bookings.id, id));
  if (!row) notFound();
  const b = row.booking;

  const profiles = await profileCapabilitiesOwnedBy(userId);
  const performer = profiles.owned.performer;
  const venue = profiles.owned.venue;
  const accountActive = accountCanAct(profiles.accountStatus);
  const canStartVenueMarketplaceAction = profiles.live.venue?.id === b.venueId;
  const asPerformer = performer?.id === b.performerId;
  const asVenue = venue?.id === b.venueId;
  if (!asPerformer && !asVenue) notFound();

  const state = b.state as BookingState;
  const reviewable = isReviewableBookingState(state);
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
  const platformPaymentsEnabled = paymentsEnabled();
  const cancellationCopy = confirmedCancellationCopy({
    role: asVenue ? "venue" : "performer",
    paymentsEnabled: platformPaymentsEnabled,
    startsAt: b.terms.startsAt,
  });

  // A cancelled state alone is ambiguous: an offer can be cancelled before or
  // after confirmation. Check history only in those two states so an unaccepted
  // offer never unlocks day-of details that were not previously visible.
  const cancellationWasConfirmed =
    state === "cancelled_by_venue" || state === "cancelled_by_performer"
      ? await bookingWasConfirmed(id)
      : false;
  // Contact reveal at confirmation (PRD F5.1): day-of phones, not before.
  const contactsRevealed = bookingContactsAreVisible(
    state,
    cancellationWasConfirmed,
  );

  // These reads are independent of one another — one round-trip of latency,
  // not one per read, on the busiest page in the product.
  const [rebookTarget, subslots, myReview, bookingOwners] =
    await Promise.all([
      // Re-offer this act into the best matching open date. The target listing
      // supplies its own date and budget, including for one-off nights.
      canStartVenueMarketplaceAction ? findRebookTarget(id) : Promise.resolve(null),
      // Tech sub-slots on this booking (PRD F6.2/F6.3)
      d
        .select()
        .from(schema.techSubslots)
        .where(eq(schema.techSubslots.bookingId, id))
        .orderBy(
          desc(schema.techSubslots.createdAt),
          desc(schema.techSubslots.id),
        ),
      reviewable
        ? d
            .select()
            .from(schema.reviews)
            .where(
              and(eq(schema.reviews.bookingId, id), eq(schema.reviews.authorRole, myRole)),
            )
            .then((r) => r[0])
        : Promise.resolve(undefined),
      // Both owner accounts in ONE read: `status` feeds the sound-job
      // availability facts, `phone`/`email` the day-of contact card. The
      // booking query above already carries both owner IDs, so the two contact
      // reads were joining back through venues/performers to re-derive them.
      d
        .select({
          id: schema.users.id,
          status: schema.users.status,
          phone: schema.users.phone,
          email: schema.users.email,
        })
        .from(schema.users)
        .where(
          inArray(schema.users.id, [
            row.venueOwnerUserId,
            row.performerOwnerUserId,
          ]),
        ),
    ]);

  // Keyed by owner ID, never by position: one person can own both the venue and
  // the act on the same booking, and then this read returns a single row.
  const ownerByUserId = new Map(bookingOwners.map((owner) => [owner.id, owner]));
  const venueOwner = ownerByUserId.get(row.venueOwnerUserId);
  const performerOwner = ownerByUserId.get(row.performerOwnerUserId);

  // Only the paying party reviews applications and applicant notes. The other
  // booking party can still see each sound job's state and history.
  const payerSubslotIds = new Set(
    subslots
      .filter((subslot) => isSubslotPayer(subslot, b, { performer, venue }))
      .map((subslot) => subslot.id),
  );
  const applicantVisibleSubslotIds = [...payerSubslotIds];
  const subslotApplicants = applicantVisibleSubslotIds.length
    ? await d
        .select({
          application: schema.techSubslotApplications,
          tech: schema.techs,
          techOwnerStatus: schema.users.status,
        })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techs, eq(schema.techSubslotApplications.techId, schema.techs.id))
        .innerJoin(schema.users, eq(schema.techs.ownerUserId, schema.users.id))
        .where(
          inArray(
            schema.techSubslotApplications.subslotId,
            applicantVisibleSubslotIds,
          ),
        )
    : [];
  const applicantsBySubslot = new Map<string, typeof subslotApplicants>();
  for (const applicant of subslotApplicants) {
    const applicants =
      applicantsBySubslot.get(applicant.application.subslotId) ?? [];
    applicants.push(applicant);
    applicantsBySubslot.set(applicant.application.subslotId, applicants);
  }
  const hasActiveSubslot = subslots.some(
    (subslot) =>
      (ACTIVE_SUBSLOT_STATES as readonly string[]).includes(subslot.state),
  );
  const soundParentAvailability = {
    bookingState: b.state,
    startsAt: b.terms.startsAt,
    venueProfileStatus: row.venueProfileStatus,
    performerProfileStatus: row.performerProfileStatus,
    venueOwnerStatus: venueOwner?.status ?? "missing",
    performerOwnerStatus: performerOwner?.status ?? "missing",
  };
  const soundParentIsActionable = isSoundParentActionable(
    soundParentAvailability,
  );
  const canPostSoundJob = accountActive && soundParentIsActionable && !hasActiveSubslot;
  const plan = soundPlan(row.paInventory, row.techNeeds);

  // The offer transaction creates this conversation. Page reads stay pure;
  // legacy rows are backfilled idempotently by the outbox worker.
  const threadId = await bookingThreadId(id);

  let contacts: { role: string; name: string; phone: string | null; email: string | null }[] = [];
  if (contactsRevealed) {
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
  return (
    <div>
      {!accountActive && (
        <div className="notice">
          Your account is not active. This booking history is read-only.
        </div>
      )}
      <div className="card">
        <h1>
          {row.performerName} at {row.venueName} <span className="badge">
            {friendlyLabel(BOOKING_STATE_LABELS, state)}
          </span>
        </h1>
        <p className="deal-terms">
          <span className="money money--lead">
            ${(b.terms.amountCents / 100).toFixed(0)}
          </span>
          <span className="gig-line">
            {formatVenueDateTimeWithZone(b.terms.startsAt, dealTimeZone)}
          </span>
        </p>
        <p className="muted">
          {venueAddress}
        </p>
        {state === "offered" && (
          <p>
            <strong>Firm offer.</strong>{" "}
            <span className="muted">
              Respond by{" "}
              {formatVenueDateTimeWithZone(b.offerExpiresAt, dealTimeZone)}. The
              venue cannot offer this night to another act while this offer is
              live.
            </span>
          </p>
        )}
        <div className="booking-actions">
          {accountActive && state === "offered" && asVenue && (
            <ActionButton
              endpoint={`/api/bookings/${id}/cancel`}
              label="Withdraw firm offer" variant="quiet"
              confirm="Withdraw this firm offer? The act will be notified and you can then offer the date to someone else."
            />
          )}{" "}
          {accountActive && state === "confirmed" && (
            <>
              <ActionButton
                endpoint={`/api/bookings/${id}/cancel`}
                label="Cancel booking" variant="quiet"
                confirm={cancellationCopy.confirm}
              />{" "}
              <span className="muted">
                {cancellationCopy.consequence}
              </span>
            </>
          )}{" "}
          {accountActive && state === "awaiting_confirmation" && asPerformer && (
            // Pressing this doesn't change state, so without the recorded
            // timestamp the page re-rendered the same button and the act had no
            // way to know it worked — several pressed it repeatedly.
            b.performerMarkedPlayedAt ? (
              <span className="muted">
                You marked this played. Waiting on the venue to confirm — it
                closes out on its own {AUTO_CONFIRM_HOURS} hours after the set ended.
              </span>
            ) : (
              <ActionButton
                endpoint={`/api/bookings/${id}/mark-played`}
                label="Mark gig as played"
              />
            )
          )}{" "}
          {accountActive && state === "awaiting_confirmation" && asVenue && (
            <>
              <ActionButton
                endpoint={`/api/bookings/${id}/confirm`}
                label={platformPaymentsEnabled ? "Confirm & release pay" : "Confirm it played"}
              />{" "}
              <p className="notice warn">
                {platformPaymentsEnabled
                  ? `Or the pay releases automatically ${AUTO_CONFIRM_HOURS} hours after the set ends, unless you open a dispute.`
                  : `Or this auto-confirms ${AUTO_CONFIRM_HOURS} hours after the set ends, unless you open a dispute. You and the act settle pay directly.`}
              </p>
            </>
          )}
        </div>
        {accountActive && state === "awaiting_confirmation" && (
          <>
            <p className="muted">
              Something go wrong? Opening a dispute{" "}
              {platformPaymentsEnabled ? "pauses the payout" : "flags it for review"}. A person
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

      {(state === "offered" ||
        (state === "confirmed" && !hasActiveSubslot)) && (
        <div className="card">
          <h2>Sound</h2>
          <p>
            <span className={soundVerdictClass(plan.verdict)}>
              {friendlyLabel(SOUND_VERDICT_LABELS, plan.verdict)}
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
          {state === "confirmed" && plan.verdict !== "covered" &&
            (canPostSoundJob ? (
              <>
                <p className="muted">
                  Post a sound job for this night — techs see the room, the
                  input list, and the pay before they say yes. Name the other
                  side as the payer and it waits for them to accept before any
                  tech sees it.
                </p>
                <ApiForm
                  endpoint={`/api/bookings/${id}/tech-subslot`}
                  submitLabel="Post the sound job"
                  fields={[
                    {
                      // Default to whoever is filling this in. It was always
                      // "venue", so an ACT's default action committed the venue to
                      // paying a tech — a bill they never agreed to. Either side
                      // can still choose the other explicitly.
                      name: "payer",
                      label: "Who pays the tech",
                      type: "select",
                      options: asPerformer
                        ? ["performer", "venue"]
                        : ["venue", "performer"],
                      defaultValue: asPerformer ? "performer" : "venue",
                      required: true,
                    },
                    { name: "budgetCents", label: "Tech pay, in dollars", type: "number", required: true },
                    { name: "notes", label: "Anything the tech should know", type: "textarea" },
                  ]}
                />
              </>
            ) : (
              <p className="muted">
                This sound plan is read-only because the gig has started or a
                booking profile is no longer active.
              </p>
            ))}
        </div>
      )}

      {subslots.map((subslot) => {
        const applicants = applicantsBySubslot.get(subslot.id) ?? [];
        const soundAvailability = {
          ...soundParentAvailability,
          subslotState: subslot.state,
        };
        const jobIsActionable = isSoundJobActionable(soundAvailability);
        const cancellationIsActionable =
          isPayerSoundCancellationActionable(soundAvailability);
        const amPayer = payerSubslotIds.has(subslot.id);
        // A proposal can only have been posted by the party that is not paying
        // for it, so on this booking the other party IS the proposer.
        const consentIsActionable = isSoundConsentActionable(soundAvailability);
        const payerLabel = friendlyLabel(PARTY_LABELS, subslot.payer);
        return (
          <div className="card" key={subslot.id}>
            <h2>Sound job</h2>
            <p>
              <span className="badge">
                {friendlyLabel(SOUND_STATE_LABELS, subslot.state)}
              </span>{" "}
              <span className="money">
                ${(subslot.budgetCents / 100).toFixed(0)}
              </span>{" "}
              <span className="muted">
                / paid by the {payerLabel}
              </span>
            </p>
            {subslot.needs.gaps.length > 0 && (
              <p className="muted">
                Gaps: {subslot.needs.gaps.join("; ")}
              </p>
            )}
            {subslot.state === "awaiting_payer" &&
              (amPayer ? (
                <>
                  <p>
                    The other side posted this and put it on your tab. Nothing
                    goes out to techs unless you say yes.
                  </p>
                  {accountActive && consentIsActionable && (
                    <p>
                      <ActionButton
                        endpoint={`/api/tech-subslots/${subslot.id}/consent`}
                        label={`Accept — pay $${(subslot.budgetCents / 100).toFixed(0)} for sound`}
                        body={{ decision: "accept" }}
                      />{" "}
                      <ActionButton
                        endpoint={`/api/tech-subslots/${subslot.id}/consent`}
                        label="Decline" variant="quiet"
                        body={{ decision: "decline" }}
                        confirm="Decline this sound job? It never goes out to techs and the other side is told."
                      />
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="muted">
                    Waiting on the {payerLabel} to agree to the cost. Techs
                    don&rsquo;t see this job until they do.
                  </p>
                  {accountActive && consentIsActionable && (
                    <ActionButton
                      endpoint={`/api/tech-subslots/${subslot.id}/cancel`}
                      label="Withdraw the proposal" variant="quiet"
                      confirm="Withdraw this sound job? The other side is told it no longer needs an answer."
                    />
                  )}
                </>
              ))}
            {amPayer &&
              applicants.map(({ application, tech, techOwnerStatus }) => {
                const applicantIsBookable = isSoundApplicantBookable({
                  applicationStatus: application.status,
                  techProfileStatus: tech.status,
                  techOwnerStatus,
                  jobIsActionable,
                });
                return (
                  <p key={application.id}>
                    <strong>{tech.name}</strong>{" "}
                    <span className="badge">
                      {friendlyLabel(GEAR_LABELS, tech.gear)}
                    </span>{" "}
                    <span className="badge">
                      {friendlyLabel(
                        SOUND_APPLICATION_LABELS_REVIEW,
                        application.status,
                      )}
                    </span>
                    {application.note && (
                      <span className="muted">
                        {" / “"}
                        <span className="user-text">{application.note}</span>
                        {"”"}
                      </span>
                    )}{" "}
                    {accountActive && applicantIsBookable && (
                      <ActionButton
                        endpoint={`/api/tech-subslots/${subslot.id}/book`}
                        label="Book this tech"
                        body={{ techId: tech.id }}
                      />
                    )}
                    {jobIsActionable &&
                      application.status === "submitted" &&
                      !applicantIsBookable && (
                        <span className="muted">
                          {" "}/ This tech is not currently available to book.
                        </span>
                      )}
                  </p>
                );
              })}
            {amPayer && subslot.state === "open" && applicants.length === 0 && (
              <p className="muted">
                {jobIsActionable
                  ? "No techs have applied yet — this appears with their open sound gigs."
                  : "This sound job is no longer accepting applications."}
              </p>
            )}
            <p>
              <Link href={`/sound/${subslot.id}`}>Open sound job details</Link>
            </p>
            {accountActive && amPayer && cancellationIsActionable && (
              <ActionButton
                endpoint={`/api/tech-subslots/${subslot.id}/cancel`}
                label="Cancel sound job" variant="quiet"
                confirm={payerSoundCancellationConfirmation(soundAvailability)}
              />
            )}
          </div>
        );
      })}

      {state === "confirmed" && (
        <div className="card">
          <h2>What happens next</h2>
          <ol className="steps">
            <li>
              <strong>Day-of contacts are unlocked below</strong> — phone and
              email for both sides, for load-in and anything last-minute.
            </li>
            <li>
              <strong>We remind everyone the day before.</strong> No action
              needed unless plans change.
            </li>
            {asPerformer ? (
              <li>
                <strong>After you play, mark the gig played</strong> right here —
                that starts the wrap-up.
              </li>
            ) : (
              <li>
                <strong>After the night, confirm it happened</strong> right here —
                that wraps the booking.
              </li>
            )}
            <li>
              <strong>Then you can review each other.</strong> Reviews come only
              from real bookings like this one.
            </li>
          </ol>
        </div>
      )}

      {threadId && (
        <div className="card">
          <h2>Messages about this booking</h2>
          <p>
            <Link href={`/inbox/${threadId}`}>Open the conversation</Link>
          </p>
          <p className="muted">
            Ask about the offer, then keep set-time, load-in, and pay changes
            here so both of you have the same written record.
          </p>
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

      {accountActive && reviewable && !myReview && (
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
            Send {row.performerName} a firm offer for this open night. Its listed
            budget is ${(rebookTarget.amountCents / 100).toFixed(0)}.
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
            paymentsEnabled: platformPaymentsEnabled,
            templateVersion: b.agreementTemplateVer,
          })}
        </pre>
        {accountActive && state === "offered" && asPerformer && (
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
              label="Decline this offer" variant="quiet"
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
