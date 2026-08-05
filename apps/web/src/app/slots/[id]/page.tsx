import {
  performerReliability,
  SLOT_HOLDING_BOOKING_STATES,
  soundPlan,
} from "@gigit/domain";
import { db, paymentsEnabled, performerReliabilityStats, schema } from "@gigit/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { profileCapabilitiesOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { accountCanAct } from "@/lib/profile-capabilities";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";
import {
  declinedApplicationMessage,
  effectiveSlotStatus,
} from "@/lib/slot-display";

export const dynamic = "force-dynamic";

import {
  SOUND_VERDICT_LABELS,
  ACT_KIND_LABEL,
  APPLICATION_STATUS_LABELS,
  GIG_FORMAT_LABEL,
  SLOT_STATUS_LABELS,
  friendlyLabel,
} from "@/lib/labels";


export default async function SlotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const [row] = await d
    .select({
      slot: schema.slots,
      venue: schema.venues,
      venueOwnerStatus: schema.users.status,
    })
    .from(schema.slots)
    .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
    .innerJoin(schema.users, eq(schema.venues.ownerUserId, schema.users.id))
    .where(eq(schema.slots.id, id));
  if (!row) notFound();
  const { slot, venue, venueOwnerStatus } = row;
  const displayStatus = effectiveSlotStatus(slot.status, slot.startsAt);
  const marketplaceOpen =
    displayStatus === "open" && venue.status === "live" && venueOwnerStatus === "active";

  const userId = await sessionUserId();
  const profiles = userId ? await profileCapabilitiesOwnedBy(userId) : null;
  const accountActive = accountCanAct(profiles?.accountStatus);
  const ownedPerformer = profiles?.owned.performer ?? null;
  const performer = profiles?.live.performer ?? null;
  const ownedVenue = profiles?.owned.venue ?? null;
  const liveVenue = profiles?.live.venue ?? null;
  const isOwner = ownedVenue?.id === venue.id;
  const canManage = liveVenue?.id === venue.id;

  const applicants = isOwner
    ? await d
        .select({
          application: schema.applications,
          performer: schema.performers,
          performerOwnerStatus: schema.users.status,
        })
        .from(schema.applications)
        .innerJoin(
          schema.performers,
          eq(schema.applications.performerId, schema.performers.id),
        )
        .innerJoin(
          schema.users,
          eq(schema.performers.ownerUserId, schema.users.id),
        )
        .where(eq(schema.applications.slotId, slot.id))
    : [];

  const holdingBooking = isOwner
    ? (
        await d
          .select({
            id: schema.bookings.id,
            performerId: schema.bookings.performerId,
            offerExpiresAt: schema.bookings.offerExpiresAt,
            state: schema.bookings.state,
          })
          .from(schema.bookings)
          .where(
            and(
              eq(schema.bookings.slotId, slot.id),
              inArray(schema.bookings.state, SLOT_HOLDING_BOOKING_STATES),
            ),
          )
          .limit(1)
      )[0] ?? null
    : null;

  // Reliability is the trust layer with payments deferred — surface it where
  // the venue actually picks an act (PRD F7.3).
  const relStats = isOwner
    ? await performerReliabilityStats(applicants.map((a) => a.performer.id))
    : new Map();

  // A visiting performer's own application on this slot (for apply/withdraw).
  const myApplication =
    ownedPerformer && !isOwner
      ? (
          await d
            .select()
            .from(schema.applications)
            .where(
              and(
                eq(schema.applications.slotId, slot.id),
                eq(schema.applications.performerId, ownedPerformer.id),
              ),
            )
        )[0] ?? null
      : null;

  return (
    <div>
      <div className="card">
        <h1>
          {venue.name}{" "}
          <span className="badge">{GIG_FORMAT_LABEL[slot.format] ?? slot.format}</span>{" "}
          <span className="badge">{friendlyLabel(SLOT_STATUS_LABELS, displayStatus)}</span>
        </h1>
        <p className="deal-terms">
          <span className="money money--lead">
            ${(slot.budgetCents / 100).toFixed(0)}
          </span>
          <span className="gig-line">
            {formatVenueDateTime(slot.startsAt, venue.timeZone)}{" "}
            {shortTimeZoneName(slot.startsAt, venue.timeZone)} · {slot.durationMinutes} min
          </span>
        </p>
        {slot.notes && <p>{slot.notes}</p>}
        <p className="muted">{formatAddress(venue)}</p>
        {venue.bio && <p className="muted">{venue.bio}</p>}
        <p className="muted">
          Sound: {venue.paInventory.hasPA ? "house PA" : "no house PA"} · Capacity:{" "}
          {venue.capacity ?? "not listed"}
        </p>
        {ownedPerformer &&
          !isOwner &&
          (marketplaceOpen ||
            Boolean(
              myApplication && myApplication.status !== "withdrawn",
            )) && (
          myApplication?.status === "submitted" ? (
            <p>
              <span className="badge">Application sent</span>{" "}
              {accountActive ? (
                <ActionButton
                  endpoint={`/api/applications/${myApplication.id}/status`}
                  label="Withdraw application" variant="quiet"
                  body={{ action: "withdraw" }}
                  confirm="Withdraw your application from this gig?"
                />
              ) : (
                <span className="muted">Your account must be active to withdraw.</span>
              )}
            </p>
          ) : myApplication && myApplication.status !== "withdrawn" ? (
            <p className="muted">
              {myApplication.status === "declined"
                ? declinedApplicationMessage(myApplication.declineReason)
                : `Your application is ${friendlyLabel(APPLICATION_STATUS_LABELS, myApplication.status).toLowerCase()}.`}
            </p>
          ) : performer ? (
            // No application yet — or a withdrawn one, which re-applying
            // revives (declining an offer must never dead-end the pairing).
            <div>
              <p className="muted">
                Your profile carries the essentials. Add a short note if there
                is something specific the venue should know.
              </p>
              <ApiForm
                endpoint={`/api/slots/${slot.id}/applications`}
                submitLabel="Apply for this gig"
                fields={[
                  {
                    name: "note",
                    label: "Note to the venue (optional)",
                    type: "textarea",
                    placeholder: "Why this night is a good fit, lineup details, or a quick hello",
                  },
                ]}
              />
            </div>
          ) : (
            <p className="muted">Your act profile must be active to apply.</p>
          )
        )}
        {!isOwner && marketplaceOpen && !ownedPerformer && (
          <p className="muted">
            Want this gig?{" "}
            {userId ? (
              <Link href="/onboarding?role=performer">Create an act profile</Link>
            ) : (
              <>
                <Link href={`/login?next=${encodeURIComponent(`/slots/${slot.id}`)}`}>Sign in</Link>
                {" or "}
                <Link href="/onboarding?role=performer">create an act profile</Link>
              </>
            )}{" "}
            to apply.
          </p>
        )}
        {!isOwner && !marketplaceOpen && (
          <p className="muted">
            {displayStatus === "filled"
              ? "This gig has been booked."
              : displayStatus === "expired"
                ? "This date has passed."
                : displayStatus === "cancelled"
                  ? "This gig was cancelled."
                  : "This gig is not accepting applications yet."}
          </p>
        )}
      </div>

      {canManage && marketplaceOpen && !holdingBooking && (
        <div className="card">
          <h2>Manage this open date</h2>
          <details>
            <summary className="muted">Edit listing</summary>
            <ApiForm
              endpoint={`/api/slots/${slot.id}`}
              method="PATCH"
              submitLabel="Save changes"
              fields={[
                { name: "budgetCents", label: "Pay for the night, in dollars", type: "number", defaultValue: slot.budgetCents / 100 },
                { name: "durationMinutes", label: "Duration (min)", type: "number", defaultValue: slot.durationMinutes },
                { name: "notes", label: "About the night", type: "textarea", defaultValue: slot.notes ?? "", emptyValue: "empty-string" },
              ]}
            />
          </details>
          <p style={{ marginTop: 8 }}>
            <ActionButton
              endpoint={`/api/slots/${slot.id}`}
              label="Close this listing" variant="quiet"
              method="DELETE"
              confirm="Close this listing? It will no longer appear with open gigs. You can post a new date later."
            />{" "}
            <span className="muted">— removes it from open gigs; you can post a new date anytime.</span>
          </p>
        </div>
      )}

      {canManage && marketplaceOpen && holdingBooking && (
        <div className="card">
          <h2>Date on hold</h2>
          <p>
            {holdingBooking.state === "offered"
              ? "A firm offer is out, so listing terms stay fixed until it is withdrawn or expires."
              : holdingBooking.state === "confirming"
                ? "The act accepted the offer and booking confirmation is processing. Listing terms stay fixed while this finishes."
                : "This date is tied to a booking, so its listing terms cannot be changed."}{" "}
            <Link href={`/bookings/${holdingBooking.id}`}>
              {holdingBooking.state === "offered"
                ? "Review or withdraw the offer"
                : "Review the pending booking"}
            </Link>
            .
          </p>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <h2>Applicants ({applicants.length})</h2>
          {applicants.length === 0 && (
            <p className="muted">No applications yet. Share this listing or check back soon.</p>
          )}
          {applicants.map(({ application, performer: p, performerOwnerStatus }) => {
            const plan = soundPlan(venue.paInventory, p.techNeeds);
            const rel = performerReliability(
              relStats.get(p.id) ?? { gigsCompleted: 0, cancellations: 0 },
            );
            const applicantCanReceiveOffer =
              p.status === "live" && performerOwnerStatus === "active";
            return (
            <div className="card" key={application.id}>
              <strong>
                <Link href={`/p/${p.id}`}>{p.name}</Link>
              </strong>{" "}
              <span className="badge">{ACT_KIND_LABEL[p.kind] ?? "Act"}</span>{" "}
              <span className="badge" title="show-up history">{rel.label}</span>{" "}
              <span className="badge">
                {friendlyLabel(APPLICATION_STATUS_LABELS, application.status)}
              </span>{" "}
              <span
                className={
                  plan.verdict === "covered"
                    ? "badge good"
                    : plan.verdict === "unknown"
                      ? "badge warn"
                      : "badge"
                }
              >
                {friendlyLabel(SOUND_VERDICT_LABELS, plan.verdict)}
              </span>
              {plan.gaps.length > 0 && (
                <p className="muted">Sound gaps: {plan.gaps.join("; ")}</p>
              )}
              <p className="muted">{p.bio}</p>
              {application.note && <p>“{application.note}”</p>}
              {application.status === "offered" &&
                holdingBooking?.performerId === p.id && (
                  holdingBooking.state === "offered" ? (
                    <p>
                      <strong>Firm offer sent.</strong>{" "}
                      <span className="muted">
                        Expires{" "}
                        {formatVenueDateTime(
                          holdingBooking.offerExpiresAt,
                          venue.timeZone,
                        )}{" "}
                        {shortTimeZoneName(
                          holdingBooking.offerExpiresAt,
                          venue.timeZone,
                        )}.{" "}
                        <Link href={`/bookings/${holdingBooking.id}`}>
                          {canManage ? "Review or withdraw the offer" : "Review the offer"}
                        </Link>
                        .
                      </span>
                    </p>
                  ) : (
                    <p>
                      <strong>
                        {holdingBooking.state === "confirming"
                          ? "Booking confirmation is processing."
                          : "This date is booked."}
                      </strong>{" "}
                      <span className="muted">
                        <Link href={`/bookings/${holdingBooking.id}`}>Review the booking</Link>.
                      </span>
                    </p>
                  )
                )}
              {canManage &&
                applicantCanReceiveOffer &&
                marketplaceOpen &&
                application.status === "submitted" &&
                !holdingBooking && (
                <>
                  <p>
                    <strong>
                      Firm offer at ${(slot.budgetCents / 100).toFixed(0)}
                    </strong>
                  </p>
                  <ApiForm
                    endpoint={`/api/applications/${application.id}/offer`}
                    submitLabel="Send firm offer"
                    extra={{ amountCents: slot.budgetCents }}
                    fields={[
                      {
                        name: "setLengthMinutes",
                        label: "Set length in minutes (optional)",
                        type: "number",
                        placeholder: String(slot.durationMinutes),
                      },
                      {
                        name: "notes",
                        label: "Offer notes (optional)",
                        type: "textarea",
                        placeholder: "Load-in, break schedule, or anything else that becomes part of the deal",
                      },
                    ]}
                  />
                  <p className="muted">
                    Pay, date, and duration match the public listing. This is one
                    firm offer; withdraw it before offering another act.{" "}
                    {paymentsEnabled()
                      ? "The contract and payment run through EightGig."
                      : "You and the act arrange pay directly, and EightGig takes no cut."}
                  </p>
                </>
              )}
              {canManage &&
                !applicantCanReceiveOffer &&
                marketplaceOpen &&
                application.status === "submitted" &&
                !holdingBooking && (
                <p className="muted">
                  This act profile is no longer available for a new offer.
                </p>
              )}

              {displayStatus === "open" &&
                application.status === "submitted" &&
                holdingBooking && (
                <p className="muted">
                  {holdingBooking.state === "offered"
                    ? "A firm offer is already out. Withdraw it or wait for it to expire before offering another act."
                    : holdingBooking.state === "confirming"
                      ? "This date is on hold while booking confirmation finishes."
                      : "This date is already tied to a booking."}
                </p>
              )}
              {canManage &&
                marketplaceOpen &&
                application.status === "submitted" && (
                <ActionButton
                  endpoint={`/api/applications/${application.id}/status`}
                  label="Decline" variant="quiet"
                  body={{ action: "decline" }}
                  confirm={`Decline ${p.name}'s application? This cannot be undone.`}
                />
              )}
              {canManage && marketplaceOpen &&
                plan.verdict !== "covered" && (
                <p className="muted">
                  <Link href="/techs">Find a tech for the night →</Link>
                </p>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
