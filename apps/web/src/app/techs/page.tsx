import { db, schema } from "@gigit/db";
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

const GEAR_LABEL: Record<string, string> = {
  none: "labor only",
  partial: "partial rig",
  full_rig: "full PA rig",
};

/** Sound tech directory — venues and performers can hire sound (PRD F6). */
export default async function TechsPage() {
  const techs = await db()
    .select()
    .from(schema.techs)
    .orderBy(asc(schema.techs.createdAt))
    .limit(100);

  const userId = await sessionUserId();
  const canInvite = userId
    ? !!(await venueOwnedBy(userId)) || !!(await performerOwnedBy(userId))
    : false;
  const myTech = userId ? await techOwnedBy(userId) : null;

  const myApplications = myTech
    ? await db()
        .select()
        .from(schema.techSubslotApplications)
        .where(eq(schema.techSubslotApplications.techId, myTech.id))
    : [];
  const myApplicationBySubslot = new Map(
    myApplications.map((application) => [application.subslotId, application]),
  );

  // Open sound slots (PRD F6.2): the gig context comes with the listing.
  const openSubslots = await db()
    .select({
      subslot: schema.techSubslots,
      terms: schema.bookings.terms,
      venueName: schema.venues.name,
      venueAddressLine1: schema.venues.addressLine1,
      venueAddressLine2: schema.venues.addressLine2,
      venueCity: schema.venues.city,
      venueRegion: schema.venues.region,
      venuePostalCode: schema.venues.postalCode,
      venueTimeZone: schema.venues.timeZone,
      paInventory: schema.venues.paInventory,
      performerName: schema.performers.name,
    })
    .from(schema.techSubslots)
    .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.techSubslots.state, "open"))
    .orderBy(asc(schema.techSubslots.createdAt))
    .limit(50);

  return (
    <div>
      <h1>Sound techs</h1>
      <div className="card">
        <h2>Gigs that need sound</h2>
        {openSubslots.length === 0 && (
          <p className="muted">
            Nothing open right now. Sound slots post here when a booked night
            needs a tech — room specs and input list included.
          </p>
        )}
        {openSubslots.map(({
          subslot,
          terms,
          venueName,
          venueAddressLine1,
          venueAddressLine2,
          venueCity,
          venueRegion,
          venuePostalCode,
          venueTimeZone,
          paInventory,
          performerName,
        }) => (
          <div className="card" key={subslot.id}>
            <strong>{performerName}</strong> at <strong>{venueName}</strong>{" "}
            <span className="money">${(subslot.budgetCents / 100).toFixed(0)}</span>
            <p className="muted">
              {formatVenueDateTime(terms.startsAt, venueTimeZone)}{" "}
              {shortTimeZoneName(terms.startsAt, venueTimeZone)}{" "}
              · {subslot.needs.inputs} inputs · house PA:{" "}
              {paInventory.hasPA
                ? `${paInventory.mixerChannels ?? "?"} ch`
                : "none — bring a rig"}
              {subslot.needs.gaps.length > 0 && <> · gaps: {subslot.needs.gaps.join("; ")}</>}
              {subslot.needs.notes && <> · {subslot.needs.notes}</>}
            </p>
            <p className="muted">
              {formatAddress({
                addressLine1: venueAddressLine1,
                addressLine2: venueAddressLine2,
                city: venueCity,
                region: venueRegion,
                postalCode: venuePostalCode,
              })}
            </p>
            <p className="muted">
              The {subslot.payer} pays you directly; Gigit never touches the gig money.
            </p>
            {myTech ? (
              myApplicationBySubslot.has(subslot.id) ? (
                <p>
                  <span className="badge">{myApplicationBySubslot.get(subslot.id)!.status}</span>{" "}
                  <Link href={"/sound/" + subslot.id}>View your application</Link>
                </p>
              ) : (
                <ActionButton
                  endpoint={`/api/tech-subslots/${subslot.id}/applications`}
                  label="Apply — pay as listed"
                />
              )
            ) : (
              <span className="muted">Create a tech profile to apply.</span>
            )}
          </div>
        ))}
      </div>
      <p className="muted">
        Live engineers, with or without a rig — booked on the same feed, with the
        same standing as the act. Venues and performers can message them directly
        to cover a night.
      </p>
      {techs.length === 0 && (
        <div className="card">No techs on the board yet.</div>
      )}
      {techs.map((t) => (
        <div className="card" key={t.id}>
          <strong>
            <Link href={`/t/${t.id}`}>{t.name}</Link>
          </strong>{" "}
          <span className="badge">{GEAR_LABEL[t.gear]}</span>{" "}
          {t.reliabilityStrikes > 0 && (
            <span className="badge">{t.reliabilityStrikes} cancellation{t.reliabilityStrikes === 1 ? "" : "s"}</span>
          )}
          <p className="muted">{t.bio}</p>
          <p className="muted">
            {t.rateLaborCents != null && (
              <>
                labor{" "}
                <span className="money">
                  ${(t.rateLaborCents / 100).toFixed(0)}
                </span>
              </>
            )}
            {t.rateWithRigCents != null && (
              <>
                {" "}
                · with rig{" "}
                <span className="money">
                  ${(t.rateWithRigCents / 100).toFixed(0)}
                </span>
              </>
            )}{" "}
            · travels {t.travelRadiusKm} km
          </p>
          {canInvite && (
            <ApiForm
              endpoint="/api/threads"
              submitLabel="Message"
              redirectTo="/inbox"
              fields={[
                { name: "body", label: `Message ${t.name}`, type: "textarea", required: true },
              ]}
              extra={{ techId: t.id }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
