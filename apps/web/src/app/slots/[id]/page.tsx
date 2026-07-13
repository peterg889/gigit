import { performerReliability, soundPlan } from "@gigit/domain";
import { db, paymentsEnabled, performerReliabilityStats, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { performerOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";

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

  const activeOffer = isOwner
    ? (
        await d
          .select({
            id: schema.bookings.id,
            performerId: schema.bookings.performerId,
            offerExpiresAt: schema.bookings.offerExpiresAt,
          })
          .from(schema.bookings)
          .where(
            and(
              eq(schema.bookings.slotId, slot.id),
              eq(schema.bookings.state, "offered"),
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
    performer && !isOwner
      ? (
          await d
            .select()
            .from(schema.applications)
            .where(
              and(
                eq(schema.applications.slotId, slot.id),
                eq(schema.applications.performerId, performer.id),
              ),
            )
        )[0] ?? null
      : null;

  return (
    <div>
      <div className="card">
        <h1>
          {venue.name} <span className="badge">{slot.format}</span>{" "}
          <span className="badge">{slot.status}</span>
        </h1>
        <p>
          {formatVenueDateTime(slot.startsAt, venue.timeZone, "full")}{" "}
          {shortTimeZoneName(slot.startsAt, venue.timeZone)}{" "}
          / {slot.durationMinutes} min /{" "}
          <span className="money">${(slot.budgetCents / 100).toFixed(0)}</span>
        </p>
        {slot.notes && <p>{slot.notes}</p>}
        <p className="muted">
          {formatAddress(venue)} / {venue.bio} / PA:{" "}
          {venue.paInventory.hasPA ? "house system" : "none"} /
          capacity {venue.capacity ?? "?"}
        </p>
        {performer && !isOwner && slot.status === "open" && (
          myApplication?.status === "submitted" ? (
            <p>
              <span className="badge">application pending</span>{" "}
              <ActionButton
                endpoint={`/api/applications/${myApplication.id}/status`}
                label="Withdraw application"
                body={{ action: "withdraw" }}
                confirm="Withdraw your application from this slot?"
              />
            </p>
          ) : myApplication ? (
            <p className="muted">
              Your application is {myApplication.status.replaceAll("_", " ")}.
            </p>
          ) : (
            <div>
              <p className="muted">
                Your profile carries the essentials. Add a short note if there
                is something specific the venue should know.
              </p>
              <ApiForm
                endpoint={`/api/slots/${slot.id}/applications`}
                submitLabel="Apply for this slot"
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
          )
        )}
      </div>

      {isOwner && slot.status === "open" && (
        <div className="card">
          <h2>Manage this slot</h2>
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>Edit slot</summary>
            <ApiForm
              endpoint={`/api/slots/${slot.id}`}
              method="PATCH"
              submitLabel="Save changes"
              fields={[
                { name: "budgetCents", label: "Budget ($)", type: "number", defaultValue: slot.budgetCents / 100 },
                { name: "durationMinutes", label: "Duration (min)", type: "number", defaultValue: slot.durationMinutes },
                { name: "notes", label: "About the night", type: "textarea", defaultValue: slot.notes ?? "" },
              ]}
            />
          </details>
          <p style={{ marginTop: 8 }}>
            <ActionButton
              endpoint={`/api/slots/${slot.id}`}
              label="Close this slot"
              method="DELETE"
              confirm="Close this slot? It will come off the public board. You can post a new slot later."
            />{" "}
            <span className="muted">— takes it off the board; you can always post a new one.</span>
          </p>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <h2>Applicants ({applicants.length})</h2>
          {applicants.map(({ application, performer: p }) => {
            const plan = soundPlan(venue.paInventory, p.techNeeds);
            const rel = performerReliability(
              relStats.get(p.id) ?? { gigsCompleted: 0, cancellations: 0 },
            );
            return (
            <div className="card" key={application.id}>
              <strong>
                <Link href={`/p/${p.id}`}>{p.name}</Link>
              </strong>{" "}
              <span className="badge">{p.kind}</span>{" "}
              <span className="badge" title="show-up history">{rel.label}</span>{" "}
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
              {application.status === "offered" &&
                activeOffer?.performerId === p.id && (
                  <p>
                    <strong>Firm offer sent.</strong>{" "}
                    <span className="muted">
                      Expires{" "}
                      {formatVenueDateTime(
                        activeOffer.offerExpiresAt,
                        venue.timeZone,
                      )}{" "}
                      {shortTimeZoneName(
                        activeOffer.offerExpiresAt,
                        venue.timeZone,
                      )}.{" "}
                      <Link href={`/bookings/${activeOffer.id}`}>
                        Review or withdraw the offer
                      </Link>
                      .
                    </span>
                  </p>
                )}
              {application.status === "submitted" && !activeOffer && (
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
                    Pay, date, and duration match the public slot. This is one
                    firm offer; withdraw it before offering another act.{" "}
                    {paymentsEnabled()
                      ? "The contract and payment run through Gigit."
                      : "You and the act settle pay directly - Gigit keeps the booking, not the money."}
                  </p>
                </>
              )}
              {application.status === "submitted" && activeOffer && (
                <p className="muted">
                  A firm offer is already out. Withdraw it or wait for it to
                  expire before offering another act.
                </p>
              )}
              {application.status === "submitted" && (
                <ActionButton
                  endpoint={`/api/applications/${application.id}/status`}
                  label="Decline"
                  body={{ action: "decline" }}
                  confirm={`Decline ${p.name}'s application? This cannot be undone.`}
                />
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
