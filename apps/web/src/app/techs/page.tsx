import { db, schema } from "@gigit/db";
import { asc, eq } from "drizzle-orm";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";

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

  // Open sound slots (PRD F6.2): the gig context comes with the listing.
  const openSubslots = await db()
    .select({
      subslot: schema.techSubslots,
      terms: schema.bookings.terms,
      venueName: schema.venues.name,
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
        {openSubslots.map(({ subslot, terms, venueName, paInventory, performerName }) => (
          <div className="card" key={subslot.id}>
            <strong>{performerName}</strong> at <strong>{venueName}</strong>{" "}
            <span className="money">${(subslot.budgetCents / 100).toFixed(0)}</span>
            <p className="muted">
              {new Date(terms.startsAt).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
              })}{" "}
              · {subslot.needs.inputs} inputs · house PA:{" "}
              {paInventory.hasPA
                ? `${paInventory.mixerChannels ?? "?"} ch`
                : "none — bring a rig"}
              {subslot.needs.gaps.length > 0 && <> · gaps: {subslot.needs.gaps.join("; ")}</>}
              {subslot.needs.notes && <> · {subslot.needs.notes}</>}
            </p>
            <p className="muted">Paid by the {subslot.payer}, after the show.</p>
            {myTech ? (
              <ActionButton
                endpoint={`/api/tech-subslots/${subslot.id}/applications`}
                label="Apply — pay as listed"
              />
            ) : (
              <span className="muted">Create a tech profile to apply.</span>
            )}
          </div>
        ))}
      </div>
      <p className="muted">
        Live engineers, with or without a rig — booked like the band, reviewed
        like the band. Venues and performers can message them directly to cover a
        night.
      </p>
      {techs.length === 0 && (
        <div className="card">No techs on the board yet.</div>
      )}
      {techs.map((t) => (
        <div className="card" key={t.id}>
          <strong>{t.name}</strong> <span className="badge">{GEAR_LABEL[t.gear]}</span>
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
