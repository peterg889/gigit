import { soundPlan } from "@gigit/domain";
import { db, paymentsEnabled, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { performerOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";

export const dynamic = "force-dynamic";

export default async function SlotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const [row] = await d
    .select({ slot: schema.slots, venue: schema.venues })
    .from(schema.slots)
    .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
    .where(eq(schema.slots.id, id));
  if (!row) notFound();
  const { slot, venue } = row;

  const userId = await sessionUserId();
  const performer = userId ? await performerOwnedBy(userId) : null;
  const myVenue = userId ? await venueOwnedBy(userId) : null;
  const isOwner = myVenue?.id === venue.id;

  const applicants = isOwner
    ? await d
        .select({ application: schema.applications, performer: schema.performers })
        .from(schema.applications)
        .innerJoin(
          schema.performers,
          eq(schema.applications.performerId, schema.performers.id),
        )
        .where(eq(schema.applications.slotId, slot.id))
    : [];

  return (
    <div>
      <div className="card">
        <h1>
          {venue.name} <span className="badge">{slot.format}</span>{" "}
          <span className="badge">{slot.status}</span>
        </h1>
        <p>
          {slot.startsAt.toLocaleString("en-US", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: "UTC",
          })}{" "}
          · {slot.durationMinutes} min ·{" "}
          <span className="money">${(slot.budgetCents / 100).toFixed(0)}</span>
        </p>
        {slot.notes && <p>{slot.notes}</p>}
        <p className="muted">
          {venue.bio} · PA: {venue.paInventory.hasPA ? "house system" : "none"} ·
          capacity {venue.capacity ?? "?"}
        </p>
        {performer && slot.status === "open" && (
          <ActionButton
            endpoint={`/api/slots/${slot.id}/applications`}
            label="Apply for this slot"
          />
        )}
      </div>

      {isOwner && (
        <div className="card">
          <h2>Applicants ({applicants.length})</h2>
          {applicants.map(({ application, performer: p }) => {
            const plan = soundPlan(venue.paInventory, p.techNeeds);
            return (
            <div className="card" key={application.id}>
              <strong>
                <Link href={`/p/${p.id}`}>{p.name}</Link>
              </strong>{" "}
              <span className="badge">{p.kind}</span>{" "}
              <span className="badge">{application.status}</span>{" "}
              <span className="badge">
                {plan.verdict === "covered"
                  ? "sound: covered"
                  : plan.verdict === "tech_needed"
                    ? "sound: tech needed"
                    : "sound: tech + rig needed"}
              </span>
              {plan.gaps.length > 0 && (
                <p className="muted">Sound gaps: {plan.gaps.join("; ")}</p>
              )}
              <p className="muted">{p.bio}</p>
              {application.note && <p>“{application.note}”</p>}
              {application.status === "submitted" && (
                <>
                  <ApiForm
                    endpoint={`/api/applications/${application.id}/offer`}
                    submitLabel="Send offer"
                    fields={[
                      {
                        name: "amountCents",
                        label: "Offer ($)",
                        type: "number",
                        required: true,
                      },
                    ]}
                  />
                  <p className="muted">
                    Terms lock when they accept.{" "}
                    {paymentsEnabled()
                      ? "The contract and payment run through Gigit."
                      : "You and the act settle pay directly — Gigit keeps the booking, not the money."}
                  </p>
                </>
              )}
              {plan.verdict !== "covered" && (
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
