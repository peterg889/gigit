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
  none: "Labor only",
  partial: "Partial rig",
  full_rig: "Full PA rig",
};

const APPLICATION_STATUS_LABEL: Record<string, string> = {
  submitted: "Application sent",
  booked: "Booked",
  declined: "Not selected",
  withdrawn: "Withdrawn",
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
      <p className="muted">
        Find local live engineers by their experience, rates, equipment, and
        travel range. Venues and acts can contact them directly when a night
        needs sound.
      </p>
      <div className="card">
        <h2>Gigs that need sound</h2>
        {openSubslots.length === 0 && (
          <>
            <p className="muted">
              No sound jobs are open right now. New jobs appear here when a
              booked gig needs a tech, with room specs and an input list included.
            </p>
            {!myTech && (
              <p>
                <Link href="/onboarding?role=tech">Create a sound tech profile</Link>{" "}
                so you are ready to apply.
              </p>
            )}
          </>
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
              · {subslot.needs.inputs} inputs ·{" "}
              {paInventory.hasPA
                ? paInventory.mixerChannels != null
                  ? `house PA · ${paInventory.mixerChannels} channels`
                  : "house PA · channel count not listed"
                : "no house PA · bring a rig"}
              {subslot.needs.gaps.length > 0 && <> · sound gaps: {subslot.needs.gaps.join("; ")}</>}
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
              The {subslot.payer === "venue" ? "venue" : "act"} pays you directly;
              Gigit does not process the gig payment.
            </p>
            {myTech ? (
              myApplicationBySubslot.has(subslot.id) ? (
                <p>
                  <span className="badge">
                    {APPLICATION_STATUS_LABEL[myApplicationBySubslot.get(subslot.id)!.status] ??
                      "Application updated"}
                  </span>{" "}
                  <Link href={"/sound/" + subslot.id}>View your application</Link>
                </p>
              ) : (
                <ActionButton
                  endpoint={`/api/tech-subslots/${subslot.id}/applications`}
                  label="Apply — pay as listed"
                />
              )
            ) : (
              <span className="muted">
                <Link href="/onboarding?role=tech">Create a sound tech profile</Link>{" "}
                to apply.
              </span>
            )}
          </div>
        ))}
      </div>
      <h2>Sound tech directory</h2>
      {techs.length === 0 && (
        <div className="card">
          No sound tech profiles yet. {!myTech && (
            <Link href="/onboarding?role=tech">Create the first one.</Link>
          )}
        </div>
      )}
      {techs.map((t) => (
        <div className="card" key={t.id}>
          <strong>
            <Link href={`/t/${t.id}`}>{t.name}</Link>
          </strong>{" "}
          <span className="badge">{GEAR_LABEL[t.gear] ?? "Equipment not listed"}</span>{" "}
          {t.reliabilityStrikes > 0 && (
            <span className="badge">{t.reliabilityStrikes} cancellation{t.reliabilityStrikes === 1 ? "" : "s"}</span>
          )}
          <p className="muted">{t.bio || "No experience summary yet."}</p>
          <p className="muted">
            {t.rateLaborCents != null && (
              <>
                Labor: {" "}
                <span className="money">
                  ${(t.rateLaborCents / 100).toFixed(0)}
                </span>
              </>
            )}
            {t.rateLaborCents != null && t.rateWithRigCents != null && " · "}
            {t.rateWithRigCents != null && (
              <>
                With rig: {" "}
                <span className="money">
                  ${(t.rateWithRigCents / 100).toFixed(0)}
                </span>
              </>
            )}
            {t.rateLaborCents == null && t.rateWithRigCents == null && "Rates not listed"}
            {" · "}Travels {t.travelRadiusKm} km
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
