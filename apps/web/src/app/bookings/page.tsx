import { db, schema } from "@gigit/db";
import { desc, eq, or } from "drizzle-orm";
import Link from "next/link";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton } from "@/components/ApiForm";
import { formatVenueDateTime, shortTimeZoneName } from "@/lib/date-time";

export const dynamic = "force-dynamic";

import {
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
  const [performer, venue, tech] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
    techOwnedBy(userId),
  ]);
  if (!performer && !venue && !tech)
    return (
      <div className="card">
        Create a <Link href="/me">profile</Link> first.
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
  const soundRows = tech
    ? await d
        .select({
          application: schema.techSubslotApplications,
          subslot: schema.techSubslots,
          terms: schema.bookings.terms,
          performerName: schema.performers.name,
          venueName: schema.venues.name,
          venueTimeZone: schema.venues.timeZone,
        })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techSubslots, eq(schema.techSubslotApplications.subslotId, schema.techSubslots.id))
        .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
        .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
        .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
        .where(eq(schema.techSubslotApplications.techId, tech.id))
        .orderBy(desc(schema.techSubslots.createdAt))
    : [];

  return (
    <div>
      <h1>Bookings</h1>
      {rows.length === 0 && soundRows.length === 0 && (
        <div className="card">
          <p>Nothing on your calendar yet.</p>
          {venue && <p><Link href="/slots/new">Post an open date</Link> to start hearing from acts.</p>}
          {performer && <p><Link href="/slots">Browse open gigs</Link> and apply when one fits.</p>}
          {tech && <p><Link href="/techs">See gigs that need sound</Link>.</p>}
        </div>
      )}
      {rows.map(({ booking, performerName, venueName, venueTimeZone }) => {
        const mineAsPerformer = performer?.id === booking.performerId;
        const cancellable = ["confirmed"].includes(booking.state);
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
            <div className="muted">
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
                  {mineAsPerformer ? "Review the deal and respond" : "Review or withdraw the offer"}
                </Link>
              </p>
            )}{" "}
            {cancellable && (
              <ActionButton
                endpoint={`/api/bookings/${booking.id}/cancel`}
                label="Cancel booking"
                confirm={
                  mineAsPerformer
                    ? "Cancel this booking? The venue will reopen the date, and this cancellation counts against your reliability."
                    : "Cancel this booking? The date will reopen. Settle anything already arranged with the act directly."
                }
              />
            )}
          </div>
        );
      })}
      {soundRows.length > 0 && (
        <>
          <h2>Sound work</h2>
          {soundRows.map(({ application, subslot, terms, performerName, venueName, venueTimeZone }) => (
            <div className="card" key={application.id}>
              <div>
                <Link href={"/sound/" + subslot.id}>
                  <strong>{performerName}</strong> at <strong>{venueName}</strong>
                </Link>{" "}
                <span className="badge">
                  {subslot.techId === tech?.id
                    ? friendlyLabel(SOUND_STATE_LABELS, subslot.state)
                    : friendlyLabel(SOUND_APPLICATION_LABELS_OWN, application.status)}
                </span>
              </div>
              <div className="muted">
                {formatVenueDateTime(terms.startsAt, venueTimeZone)}{" "}
                {shortTimeZoneName(terms.startsAt, venueTimeZone)}{" "}
                · <span className="money">{"$"}{(subslot.budgetCents / 100).toFixed(0)}</span>
              </div>
              <p className="muted">
                {subslot.techId === tech?.id
                  ? "You are the booked tech. Open for load-in details and contacts."
                  : application.status === "submitted"
                    ? "Application pending."
                    : "This sound job was filled by another tech."}
              </p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
