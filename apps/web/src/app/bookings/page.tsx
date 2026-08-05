import { db, schema } from "@gigit/db";
import { desc, eq, inArray, or } from "drizzle-orm";
import Link from "next/link";
import { profileCapabilitiesOwnedBy } from "@/lib/auth";
import { accountCanAct } from "@/lib/profile-capabilities";
import { sessionUserId } from "@/lib/session";
import { formatVenueDateTime, shortTimeZoneName } from "@/lib/date-time";
import { declinedApplicationMessage } from "@/lib/slot-display";
import {
  isSoundJobActionable,
  isSoundParentActionable,
  soundApplicationMessage,
  soundAssignmentMessage,
} from "@/lib/sound-display";

export const dynamic = "force-dynamic";

import {
  APPLICATION_STATUS_LABELS,
  BOOKING_STATE_LABELS,
  SOUND_APPLICATION_LABELS_OWN,
  SOUND_STATE_LABELS,
  friendlyLabel,
} from "@/lib/labels";

export default async function BookingsPage() {
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> to see your bookings.
      </div>
    );
  const profiles = await profileCapabilitiesOwnedBy(userId);
  const { performer, venue, tech } = profiles.owned;
  const livePerformer = profiles.live.performer;
  const liveVenue = profiles.live.venue;
  const liveTech = profiles.live.tech;
  const accountActive = accountCanAct(profiles.accountStatus);
  if (!performer && !venue && !tech)
    return (
      <div className="card">
        {accountActive ? (
          <>Create a <Link href="/me">profile</Link> first.</>
        ) : (
          <>
            Your account is not active. <Link href="/account">Review your account</Link>.
          </>
        )}
      </div>
    );

  const conditions = [];
  if (performer) conditions.push(eq(schema.bookings.performerId, performer.id));
  if (venue) conditions.push(eq(schema.bookings.venueId, venue.id));
  const d = db();
  const rows = conditions.length
    ? await d
        .select({
          booking: schema.bookings,
          performerName: schema.performers.name,
          venueName: schema.venues.name,
          venueTimeZone: schema.venues.timeZone,
        })
        .from(schema.bookings)
        .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
        .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
        .where(or(...conditions))
        .orderBy(desc(schema.bookings.createdAt))
    : [];
  // An act's own applications (PRD F2.5). Without this the only way to learn
  // where an application stands was to revisit each slot URL one at a time —
  // and a decline was completely silent.
  const applicationRows = performer
    ? await d
        .select({
          application: schema.applications,
          slot: schema.slots,
          venueName: schema.venues.name,
          venueTimeZone: schema.venues.timeZone,
        })
        .from(schema.applications)
        .innerJoin(schema.slots, eq(schema.applications.slotId, schema.slots.id))
        .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
        .where(eq(schema.applications.performerId, performer.id))
        .orderBy(desc(schema.applications.createdAt))
        .limit(50)
    : [];

  const soundRows = tech
    ? await d
        .select({
          application: schema.techSubslotApplications,
          subslot: schema.techSubslots,
          terms: schema.bookings.terms,
          bookingState: schema.bookings.state,
          performerName: schema.performers.name,
          performerProfileStatus: schema.performers.status,
          performerOwnerUserId: schema.performers.ownerUserId,
          venueName: schema.venues.name,
          venueTimeZone: schema.venues.timeZone,
          venueProfileStatus: schema.venues.status,
          venueOwnerUserId: schema.venues.ownerUserId,
        })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techSubslots, eq(schema.techSubslotApplications.subslotId, schema.techSubslots.id))
        .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
        .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
        .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
        .where(eq(schema.techSubslotApplications.techId, tech.id))
        .orderBy(desc(schema.techSubslots.createdAt))
    : [];
  const soundOwnerRows = soundRows.length
    ? await d
        .select({ id: schema.users.id, status: schema.users.status })
        .from(schema.users)
        .where(
          inArray(
            schema.users.id,
            [
              ...new Set(
                soundRows.flatMap((row) => [
                  row.venueOwnerUserId,
                  row.performerOwnerUserId,
                ]),
              ),
            ],
          ),
        )
    : [];
  const soundOwnerStatus = new Map(
    soundOwnerRows.map((owner) => [owner.id, owner.status]),
  );

  return (
    <div>
      <h1>Bookings</h1>
      {!accountActive && (
        <div className="notice">
          Your account is not active. Booking and application history is read-only.
        </div>
      )}
      {rows.length === 0 && soundRows.length === 0 && applicationRows.length === 0 && (
        <div className="card">
          <p>Nothing on your calendar yet.</p>
          {liveVenue && <p><Link href="/slots/new">Post an open date</Link> to start hearing from acts.</p>}
          {livePerformer && <p><Link href="/slots">Browse open gigs</Link> and apply when one fits.</p>}
          {liveTech && <p><Link href="/techs">See gigs that need sound</Link>.</p>}
        </div>
      )}
      {rows.map(({ booking, performerName, venueName, venueTimeZone }) => {
        const mineAsPerformer = performer?.id === booking.performerId;
        return (
          <div className="card" key={booking.id}>
            <div>
              <Link href={`/bookings/${booking.id}`}>
                <strong>{performerName}</strong> at <strong>{venueName}</strong>
              </Link>{" "}
              <span className="badge">
                {friendlyLabel(BOOKING_STATE_LABELS, booking.state)}
              </span>
            </div>
            <div className="gig-line">
              {formatVenueDateTime(booking.terms.startsAt, booking.terms.timeZone ?? venueTimeZone)}{" "}
              {shortTimeZoneName(booking.terms.startsAt, booking.terms.timeZone ?? venueTimeZone)}{" "}
              ·{" "}
              <span className="money">
                ${(booking.terms.amountCents / 100).toFixed(0)}
              </span>
            </div>
            {booking.state === "offered" && (
              <p className="muted">
                Firm offer · respond by{" "}
                {formatVenueDateTime(booking.offerExpiresAt, booking.terms.timeZone ?? venueTimeZone)}{" "}
                {shortTimeZoneName(booking.offerExpiresAt, booking.terms.timeZone ?? venueTimeZone)}. {" "}
                <Link href={`/bookings/${booking.id}`}>
                  {!accountActive
                    ? "View the firm offer"
                    : mineAsPerformer
                      ? "Review the deal and respond"
                      : "Review or withdraw the offer"}
                </Link>
              </p>
            )}{" "}
            {/* The list's job is getting people INTO the booking — the deal,
                contacts, and day-of details. Cancellation lives on the booking
                page where the full picture (and the warning copy) is. */}
            {booking.state !== "offered" && (
              <p>
                <Link href={`/bookings/${booking.id}`}>
                  {booking.state === "confirmed"
                    ? "View booking — the deal, contacts, and day-of details"
                    : "View booking"}
                </Link>
              </p>
            )}
          </div>
        );
      })}
      {applicationRows.length > 0 && (
        <>
          <h2>Your applications</h2>
          <p className="muted">
            Every gig you have applied to and where it stands. Offers show up in
            Bookings above.
          </p>
          {applicationRows.map(({ application, slot, venueName, venueTimeZone }) => (
            <div className="card" key={application.id}>
              <div>
                <strong>
                  <Link href={`/slots/${slot.id}`}>{venueName}</Link>
                </strong>{" "}
                <span className="badge">
                  {friendlyLabel(APPLICATION_STATUS_LABELS, application.status)}
                </span>
              </div>
              <div className="gig-line">
                {formatVenueDateTime(slot.startsAt, venueTimeZone)}{" "}
                {shortTimeZoneName(slot.startsAt, venueTimeZone)} ·{" "}
                <span className="money">${(slot.budgetCents / 100).toFixed(0)}</span>
              </div>
              {application.status === "declined" && (
                <p className="muted">
                  {declinedApplicationMessage(application.declineReason)}
                  {livePerformer && (
                    <>
                      {" "}<Link href="/slots">Browse open gigs</Link>.
                    </>
                  )}
                </p>
              )}
            </div>
          ))}
        </>
      )}

      {soundRows.length > 0 && (
        <>
          <h2>Sound work</h2>
          {soundRows.map(({
            application,
            subslot,
            terms,
            bookingState,
            performerName,
            performerProfileStatus,
            performerOwnerUserId,
            venueName,
            venueTimeZone,
            venueProfileStatus,
            venueOwnerUserId,
          }) => {
            const availability = {
              subslotState: subslot.state,
              bookingState,
              startsAt: terms.startsAt,
              venueProfileStatus,
              performerProfileStatus,
              venueOwnerStatus:
                soundOwnerStatus.get(venueOwnerUserId) ?? "missing",
              performerOwnerStatus:
                soundOwnerStatus.get(performerOwnerUserId) ?? "missing",
            };
            const assignedToMe = subslot.techId === tech?.id;
            const message = assignedToMe
              ? soundAssignmentMessage({
                  subslotState: subslot.state,
                  bookingState,
                  parentIsActionable: isSoundParentActionable(availability),
                })
              : soundApplicationMessage({
                  applicationStatus: application.status,
                  subslotState: subslot.state,
                  jobIsActionable: isSoundJobActionable(availability),
                });
            return (
              <div className="card" key={application.id}>
                <div>
                  <Link href={"/sound/" + subslot.id}>
                    <strong>{performerName}</strong> at <strong>{venueName}</strong>
                  </Link>{" "}
                  <span className="badge">
                    {assignedToMe
                      ? friendlyLabel(SOUND_STATE_LABELS, subslot.state)
                      : friendlyLabel(SOUND_APPLICATION_LABELS_OWN, application.status)}
                  </span>
                </div>
                <div className="gig-line">
                  {formatVenueDateTime(terms.startsAt, venueTimeZone)}{" "}
                  {shortTimeZoneName(terms.startsAt, venueTimeZone)}{" "}
                  · <span className="money">{"$"}{(subslot.budgetCents / 100).toFixed(0)}</span>
                </div>
                <p className="muted">{message}</p>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
