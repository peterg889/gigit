import { TERMINAL_STATES, renderAgreement, soundPlan } from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import { db, paymentsEnabled, schema } from "@gigit/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { performerOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";

export const dynamic = "force-dynamic";

export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> first.
      </div>
    );
  const d = db();
  const [row] = await d
    .select({
      booking: schema.bookings,
      venueName: schema.venues.name,
      performerName: schema.performers.name,
      paInventory: schema.venues.paInventory,
      techNeeds: schema.performers.techNeeds,
    })
    .from(schema.bookings)
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.bookings.id, id));
  if (!row) notFound();
  const b = row.booking;

  const [performer, venue] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
  ]);
  const asPerformer = performer?.id === b.performerId;
  const asVenue = venue?.id === b.venueId;
  if (!asPerformer && !asVenue) notFound();

  const state = b.state as BookingState;
  const terminal = TERMINAL_STATES.has(state);
  const myRole = asVenue ? "venue" : "performer";

  // Tech sub-slots on this booking (PRD F6.2/F6.3)
  const subslots = await d
    .select()
    .from(schema.techSubslots)
    .where(eq(schema.techSubslots.bookingId, id));
  const activeSubslot = subslots.find((s) => s.state === "open" || s.state === "booked");
  const subslotApplicants = activeSubslot
    ? await d
        .select({ application: schema.techSubslotApplications, tech: schema.techs })
        .from(schema.techSubslotApplications)
        .innerJoin(schema.techs, eq(schema.techSubslotApplications.techId, schema.techs.id))
        .where(
          and(
            eq(schema.techSubslotApplications.subslotId, activeSubslot.id),
            inArray(schema.techSubslotApplications.status, ["submitted", "booked"]),
          ),
        )
    : [];
  const plan = soundPlan(row.paInventory, row.techNeeds);
  const amPayer =
    activeSubslot &&
    (activeSubslot.payer === "venue" ? asVenue : asPerformer);

  // Contact reveal at confirmation (PRD F5.1): day-of phones, not before.
  const contactsRevealed = state === "confirmed" || state === "awaiting_confirmation";
  let contacts: { role: string; name: string; phone: string | null; email: string | null }[] = [];
  if (contactsRevealed) {
    const [venueOwner] = await d
      .select({ phone: schema.users.phone, email: schema.users.email })
      .from(schema.venues)
      .innerJoin(schema.users, eq(schema.venues.ownerUserId, schema.users.id))
      .where(eq(schema.venues.id, b.venueId));
    const [performerOwner] = await d
      .select({ phone: schema.users.phone, email: schema.users.email })
      .from(schema.performers)
      .innerJoin(schema.users, eq(schema.performers.ownerUserId, schema.users.id))
      .where(eq(schema.performers.id, b.performerId));
    contacts = [
      {
        role: "Venue",
        name: row.venueName,
        phone: venueOwner?.phone ?? null,
        email: venueOwner?.email ?? null,
      },
      {
        role: "Act",
        name: row.performerName,
        phone: performerOwner?.phone ?? null,
        email: performerOwner?.email ?? null,
      },
    ];
  }
  const [myReview] = await d
    .select()
    .from(schema.reviews)
    .where(
      and(eq(schema.reviews.bookingId, id), eq(schema.reviews.authorRole, myRole)),
    );

  return (
    <div>
      <div className="card">
        <h1>
          {row.performerName} at {row.venueName} <span className="badge">{state}</span>
        </h1>
        <p>
          {new Date(b.terms.startsAt).toLocaleString("en-US", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: "UTC",
          })}{" "}
          · <span className="money">${(b.terms.amountCents / 100).toFixed(0)}</span>
        </p>
        <p>
          {state === "offered" && asPerformer && (
            <ActionButton endpoint={`/api/bookings/${id}/accept`} label="Accept offer" />
          )}{" "}
          {state === "confirmed" && (
            <ActionButton endpoint={`/api/bookings/${id}/cancel`} label="Cancel booking" />
          )}{" "}
          {state === "awaiting_confirmation" && asPerformer && (
            <ActionButton
              endpoint={`/api/bookings/${id}/mark-played`}
              label="Mark it played"
            />
          )}{" "}
          {state === "awaiting_confirmation" && asVenue && (
            <span className="muted">
              {paymentsEnabled()
                ? "The pay releases automatically 24 hours after the set ends, unless you open a dispute."
                : "This auto-confirms 24 hours after the set ends, unless you open a dispute. You and the act settle pay directly."}
            </span>
          )}
        </p>
        {state === "awaiting_confirmation" && (
          <>
            <p className="muted">
              Something go wrong? Opening a dispute{" "}
              {paymentsEnabled() ? "pauses the payout" : "flags it for review"}. A person
              looks at it within 5 business days.
            </p>
            <ApiForm
              endpoint={`/api/bookings/${id}/dispute`}
              submitLabel="Open a dispute"
              fields={[
                { name: "reason", label: "What happened?", type: "textarea", required: true },
              ]}
            />
          </>
        )}
      </div>

      {state === "confirmed" && !activeSubslot && (
        <div className="card">
          <h2>Sound</h2>
          <p>
            <span className="badge">
              {plan.verdict === "covered"
                ? "covered by house PA"
                : plan.verdict === "tech_needed"
                  ? "tech needed"
                  : "tech + rig needed"}
            </span>
            {plan.gaps.length > 0 && (
              <span className="muted"> · {plan.gaps.join("; ")}</span>
            )}
          </p>
          {plan.verdict !== "covered" && (
            <>
              <p className="muted">
                Post a sound slot for this night — techs see the room, the
                input list, and the pay before they say yes.
              </p>
              <ApiForm
                endpoint={`/api/bookings/${id}/tech-subslot`}
                submitLabel="Post the sound slot"
                fields={[
                  { name: "payer", label: "Who pays the tech", type: "select", options: ["venue", "performer"], required: true },
                  { name: "budgetCents", label: "Tech pay (USD)", type: "number", required: true, placeholder: "250" },
                  { name: "notes", label: "Anything the tech should know", type: "textarea" },
                ]}
              />
            </>
          )}
        </div>
      )}

      {activeSubslot && (
        <div className="card">
          <h2>Sound</h2>
          <p>
            <span className="badge">{activeSubslot.state}</span>{" "}
            <span className="money">
              ${(activeSubslot.budgetCents / 100).toFixed(0)}
            </span>{" "}
            <span className="muted">· paid by the {activeSubslot.payer}</span>
          </p>
          {activeSubslot.needs.gaps.length > 0 && (
            <p className="muted">Gaps: {activeSubslot.needs.gaps.join("; ")}</p>
          )}
          {subslotApplicants.map(({ application, tech }) => (
            <p key={application.id}>
              <strong>{tech.name}</strong>{" "}
              <span className="badge">{tech.gear}</span>{" "}
              <span className="badge">{application.status}</span>
              {application.note && <span className="muted"> · “{application.note}”</span>}{" "}
              {amPayer && activeSubslot.state === "open" && application.status === "submitted" && (
                <ActionButton
                  endpoint={`/api/tech-subslots/${activeSubslot.id}/book`}
                  label="Book this tech"
                  body={{ techId: tech.id }}
                />
              )}
            </p>
          ))}
          {activeSubslot.state === "open" && subslotApplicants.length === 0 && (
            <p className="muted">No techs have applied yet — they see this in their feed.</p>
          )}
          {amPayer && (
            <ActionButton
              endpoint={`/api/tech-subslots/${activeSubslot.id}/cancel`}
              label="Cancel sound slot"
            />
          )}
        </div>
      )}

      {contactsRevealed && (
        <div className="card">
          <h2>Day-of contacts</h2>
          <p className="muted">
            Shared at confirmation so nobody is hunting for a number at load-in.
          </p>
          {contacts.map((c) => (
            <p key={c.role}>
              <span className="badge">{c.role}</span> <strong>{c.name}</strong>
              {c.phone && <> · {c.phone}</>}
              {c.email && <> · {c.email}</>}
            </p>
          ))}
        </div>
      )}

      {terminal && !myReview && (
        <div className="card">
          <h2>Leave a review</h2>
          <p className="muted">
            Reviews go both ways and publish together — once you&apos;ve both
            written one, or after 7 days. Say it straight.
          </p>
          <ApiForm
            endpoint={`/api/bookings/${id}/review`}
            submitLabel="Submit review"
            transform="ratingsMulti"
            fields={[
              { name: "overall", label: "Overall (1–5)", type: "number", required: true },
              ...(myRole === "venue"
                ? [
                    { name: "draw", label: "Draw — did people come? (1–5)", type: "number" as const },
                    { name: "professionalism", label: "Professionalism (1–5)", type: "number" as const },
                    { name: "quality", label: "Performance quality (1–5)", type: "number" as const },
                  ]
                : [
                    { name: "hospitality", label: "Hospitality (1–5)", type: "number" as const },
                    { name: "accuracy", label: "Room as described? (1–5)", type: "number" as const },
                    { name: "payment", label: "Payment & terms (1–5)", type: "number" as const },
                  ]),
              { name: "body", label: "Comments", type: "textarea" as const },
            ]}
          />
        </div>
      )}
      {myReview && (
        <div className="card muted">You reviewed this booking (★ {myReview.ratings.overall}).</div>
      )}

      <div className="card">
        <h2>The deal, in writing</h2>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
          {renderAgreement({
            venueName: row.venueName,
            performerName: row.performerName,
            terms: b.terms,
            paymentsEnabled: paymentsEnabled(),
          })}
        </pre>
        <p className="muted">
          Venue accepted {b.venueAcceptedAt?.toISOString() ?? "—"} · performer accepted{" "}
          {b.performerAcceptedAt?.toISOString() ?? "—"} · template {b.agreementTemplateVer}
        </p>
      </div>
    </div>
  );
}
