import { db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

export default async function SoundBookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await sessionUserId();
  if (!userId)
    return <div className="card"><Link href="/login">Sign in</Link> to see this sound booking.</div>;

  const d = db();
  const [row] = await d
    .select({
      subslot: schema.techSubslots,
      booking: schema.bookings,
      venue: schema.venues,
      performer: schema.performers,
      techName: schema.techs.name,
      techOwnerUserId: schema.techs.ownerUserId,
    })
    .from(schema.techSubslots)
    .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .leftJoin(schema.techs, eq(schema.techSubslots.techId, schema.techs.id))
    .where(eq(schema.techSubslots.id, id));
  if (!row) notFound();

  const [myVenue, myPerformer, myTech] = await Promise.all([
    venueOwnedBy(userId),
    performerOwnedBy(userId),
    techOwnedBy(userId),
  ]);
  const isBookingParty =
    myVenue?.id === row.booking.venueId || myPerformer?.id === row.booking.performerId;
  const isAssignedTech = myTech?.id === row.subslot.techId;
  const [myApplication] = myTech
    ? await d
        .select()
        .from(schema.techSubslotApplications)
        .where(and(
          eq(schema.techSubslotApplications.subslotId, id),
          eq(schema.techSubslotApplications.techId, myTech.id),
        ))
    : [];
  if (!isBookingParty && !isAssignedTech && !myApplication) notFound();

  const payerIsMe = row.subslot.payer === "venue"
    ? myVenue?.id === row.booking.venueId
    : myPerformer?.id === row.booking.performerId;
  const reviewRole = isAssignedTech ? "tech" : payerIsMe ? "payer" : null;
  const [myReview] = reviewRole
    ? await d
        .select()
        .from(schema.techSubslotReviews)
        .where(and(
          eq(schema.techSubslotReviews.subslotId, id),
          eq(schema.techSubslotReviews.authorRole, reviewRole),
        ))
    : [];
  const applicants = payerIsMe
    ? await d
        .select({ application: schema.techSubslotApplications, tech: schema.techs })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techs, eq(schema.techSubslotApplications.techId, schema.techs.id))
        .where(eq(schema.techSubslotApplications.subslotId, id))
    : [];

  const contactSpecs = [
    { role: "Venue", name: row.venue.name, userId: row.venue.ownerUserId },
    { role: "Act", name: row.performer.name, userId: row.performer.ownerUserId },
    ...(row.techOwnerUserId
      ? [{ role: "Tech", name: row.techName ?? "Sound tech", userId: row.techOwnerUserId }]
      : []),
  ];
  const contacts = row.subslot.state === "booked" && (isBookingParty || isAssignedTech)
    ? await Promise.all(contactSpecs.map(async (contact) => {
        const [user] = await d
          .select({ phone: schema.users.phone, email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, contact.userId));
        return { ...contact, phone: user?.phone, email: user?.email };
      }))
    : [];

  return (
    <div>
      <div className="card">
        <h1>
          Sound for {row.performer.name} at {row.venue.name}{" "}
          <span className="badge">{row.subslot.state.replaceAll("_", " ")}</span>
        </h1>
        <p>
          {formatVenueDateTime(row.booking.terms.startsAt, row.venue.timeZone, "full")}{" "}
          {shortTimeZoneName(row.booking.terms.startsAt, row.venue.timeZone)} ·{" "}
          <span className="money">{"$"}{(row.subslot.budgetCents / 100).toFixed(0)}</span>
        </p>
        <p className="muted">{formatAddress(row.venue)}</p>
        <p className="muted">
          The {row.subslot.payer} pays the tech directly. Gigit records the
          commitment but never touches the gig money.
        </p>
        <p>{row.subslot.needs.inputs} inputs
          {row.subslot.needs.gaps.length > 0 && <> · gaps: {row.subslot.needs.gaps.join("; ")}</>}
        </p>
        {row.subslot.needs.notes && <p>{row.subslot.needs.notes}</p>}
        <p className="muted">House PA: {row.venue.paInventory.hasPA
          ? <>{row.venue.paInventory.mixerChannels ?? "?"} channels, {row.venue.paInventory.micsAvailable ?? 0} mics, {row.venue.paInventory.monitors ?? 0} monitors</>
          : "none — bring a rig"}</p>
      </div>

      {myApplication && !isAssignedTech && (
        <div className="card">
          <h2>Your application</h2>
          <p><span className="badge">{myApplication.status}</span>{" "}
            {myApplication.status === "submitted"
              ? "The paying side has your application and will respond here."
              : "This sound slot was filled by another tech."}</p>
          {myApplication.status === "submitted" && (
            <ActionButton endpoint={"/api/tech-subslots/" + id + "/applications"}
              method="DELETE" label="Withdraw application"
              confirm="Withdraw from this sound gig?" />
          )}
        </div>
      )}

      {isAssignedTech && row.subslot.state === "booked" && (
        <div className="card">
          <h2>You are booked</h2>
          <p>Keep this page for load-in details and day-of contacts.</p>
          <ActionButton endpoint={"/api/tech-subslots/" + id + "/cancel"}
            label="Cancel sound booking"
            confirm="Cancel this sound booking? The gig will reopen for another tech." />
        </div>
      )}

      {payerIsMe && applicants.length > 0 && (
        <div className="card">
          <h2>Tech applicants</h2>
          {applicants.map(({ application, tech }) => (
            <p key={application.id}>
              <Link href={"/t/" + tech.id}><strong>{tech.name}</strong></Link>{" "}
              <span className="badge">{application.status}</span>{" "}
              {row.subslot.state === "open" && application.status === "submitted" && (
                <ActionButton endpoint={"/api/tech-subslots/" + id + "/book"}
                  label="Book this tech" body={{ techId: tech.id }}
                  confirm={"Book " + tech.name + " for $" + (row.subslot.budgetCents / 100).toFixed(0) + "?"} />
              )}
            </p>
          ))}
        </div>
      )}

      {row.subslot.state === "released" && reviewRole && !myReview && (
        <div className="card">
          <h2>Review the sound booking</h2>
          <p className="muted">
            Reviews publish once both sides submit, or after seven days.
          </p>
          <ApiForm
            endpoint={"/api/tech-subslots/" + id + "/review"}
            submitLabel="Submit review"
            transform="ratingsOverall"
            fields={[
              { name: "overall", label: "Overall (1–5)", type: "number", required: true },
              { name: "body", label: "Comments", type: "textarea" },
            ]}
          />
        </div>
      )}
      {myReview && (
        <div className="card muted">
          You reviewed this sound booking (★ {myReview.ratings.overall}).
        </div>
      )}

      {contacts.length > 0 && (
        <div className="card">
          <h2>Day-of contacts</h2>
          {contacts.map((contact) => (
            <p key={contact.role}><span className="badge">{contact.role}</span>{" "}
              <strong>{contact.name}</strong>
              {contact.phone && <> · {contact.phone}</>}
              {contact.email && <> · {contact.email}</>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
