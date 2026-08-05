import { db, schema } from "@gigit/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { profileCapabilitiesOwnedBy } from "@/lib/auth";
import { accountCanAct } from "@/lib/profile-capabilities";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";
import {
  SOUND_APPLICATION_LABELS_OWN,
  SOUND_APPLICATION_LABELS_REVIEW,
  SOUND_STATE_LABELS,
  friendlyLabel,
} from "@/lib/labels";
import {
  equipmentCount,
  isSoundApplicantBookable,
  isSoundJobActionable,
  isSoundParentActionable,
  isTechSoundCancellationActionable,
  soundApplicationMessage,
} from "@/lib/sound-display";

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

  const [profiles, ownerRows] = await Promise.all([
    profileCapabilitiesOwnedBy(userId),
    d
      .select({ id: schema.users.id, status: schema.users.status })
      .from(schema.users)
      .where(
        inArray(schema.users.id, [
          row.venue.ownerUserId,
          row.performer.ownerUserId,
        ]),
      ),
  ]);
  const myVenue = profiles.owned.venue;
  const myPerformer = profiles.owned.performer;
  const myTech = profiles.owned.tech;
  const accountActive = accountCanAct(profiles.accountStatus);
  const ownerStatus = new Map(ownerRows.map((owner) => [owner.id, owner.status]));
  const soundAvailability = {
    subslotState: row.subslot.state,
    bookingState: row.booking.state,
    startsAt: row.booking.terms.startsAt,
    venueProfileStatus: row.venue.status,
    performerProfileStatus: row.performer.status,
    venueOwnerStatus: ownerStatus.get(row.venue.ownerUserId) ?? "missing",
    performerOwnerStatus:
      ownerStatus.get(row.performer.ownerUserId) ?? "missing",
  };
  const parentIsActionable = isSoundParentActionable(soundAvailability);
  const jobIsActionable = isSoundJobActionable(soundAvailability);
  const cancellationIsActionable =
    isTechSoundCancellationActionable(soundAvailability);
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
  const canSeeOperationalDetails =
    isBookingParty || isAssignedTech || jobIsActionable;

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
        .select({
          application: schema.techSubslotApplications,
          tech: schema.techs,
          techOwnerStatus: schema.users.status,
        })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techs, eq(schema.techSubslotApplications.techId, schema.techs.id))
        .innerJoin(schema.users, eq(schema.techs.ownerUserId, schema.users.id))
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
      {!accountActive && (
        <div className="notice">
          Your account is not active. This sound-booking history is read-only.
        </div>
      )}
      <div className="card">
        <h1>
          Sound for {row.performer.name} at {row.venue.name}{" "}
          <span className="badge">
            {SOUND_STATE_LABELS[row.subslot.state] ?? "Sound job updated"}
          </span>
        </h1>
        <p>
          {formatVenueDateTime(row.booking.terms.startsAt, row.venue.timeZone, "full")}{" "}
          {shortTimeZoneName(row.booking.terms.startsAt, row.venue.timeZone)} ·{" "}
          <span className="money">{"$"}{(row.subslot.budgetCents / 100).toFixed(0)}</span>
        </p>
        {canSeeOperationalDetails && (
          <p className="muted">{formatAddress(row.venue)}</p>
        )}
        <p className="muted">
          The {row.subslot.payer === "venue" ? "venue" : "act"} pays the tech
          directly.
        </p>
        <p>{row.subslot.needs.inputs} inputs
          {row.subslot.needs.gaps.length > 0 && <> · sound gaps: {row.subslot.needs.gaps.join("; ")}</>}
        </p>
        {canSeeOperationalDetails && (
          <>
            {row.subslot.needs.notes && <p>{row.subslot.needs.notes}</p>}
            <p className="muted">
              House PA:{" "}
              {row.venue.paInventory.hasPA ? (
                <>
                  {row.venue.paInventory.mixerChannels != null
                    ? row.venue.paInventory.mixerChannels + " channels"
                    : "channel count not listed"}
                  , {equipmentCount(row.venue.paInventory.micsAvailable, "microphone")},{" "}
                  {equipmentCount(row.venue.paInventory.monitors, "monitor")}
                </>
              ) : (
                "None — bring a rig"
              )}
            </p>
          </>
        )}
      </div>

      {myApplication && !isAssignedTech && (
        <div className="card">
          <h2>Your application</h2>
          <p><span className="badge">
            {SOUND_APPLICATION_LABELS_OWN[myApplication.status] ?? "Application updated"}
          </span>{" "}
            {soundApplicationMessage({
              applicationStatus: myApplication.status,
              subslotState: row.subslot.state,
              jobIsActionable,
            })}</p>
          {myApplication.status === "submitted" &&
            jobIsActionable &&
            accountActive && (
            <ActionButton endpoint={"/api/tech-subslots/" + id + "/applications"}
              method="DELETE" label="Withdraw application" variant="quiet"
              confirm="Withdraw from this sound gig?" />
          )}
        </div>
      )}

      {isAssignedTech && row.subslot.state === "booked" && (
        <div className="card">
          <h2>You are booked</h2>
          <p>
            {parentIsActionable
              ? "Keep this page for load-in details and day-of contacts."
              : "The parent booking is no longer active or the gig has started, so this sound assignment cannot reopen."}
          </p>
          {accountActive && cancellationIsActionable && (
            <ActionButton endpoint={"/api/tech-subslots/" + id + "/cancel"}
              label="Cancel sound booking" variant="quiet"
              confirm="Cancel this sound booking? The gig will reopen for another tech." />
          )}
        </div>
      )}

      {payerIsMe && applicants.length > 0 && (
        <div className="card">
          <h2>Tech applicants</h2>
          {applicants.map(({ application, tech, techOwnerStatus }) => {
            const applicantIsBookable = isSoundApplicantBookable({
              applicationStatus: application.status,
              techProfileStatus: tech.status,
              techOwnerStatus,
              jobIsActionable,
            });
            return (
              <p key={application.id}>
                <Link href={"/t/" + tech.id}><strong>{tech.name}</strong></Link>{" "}
                <span className="badge">
                  {friendlyLabel(SOUND_APPLICATION_LABELS_REVIEW, application.status)}
                </span>{" "}
                {accountActive && applicantIsBookable && (
                  <ActionButton endpoint={"/api/tech-subslots/" + id + "/book"}
                    label="Book this tech" body={{ techId: tech.id }}
                    confirm={"Book " + tech.name + " for $" + (row.subslot.budgetCents / 100).toFixed(0) + "?"} />
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
        </div>
      )}

      {accountActive &&
        row.subslot.state === "released" && reviewRole && !myReview && (
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
