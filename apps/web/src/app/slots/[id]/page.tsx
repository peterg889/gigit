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

const SLOT_STATUS_LABELS: Record<string, string> = {
  draft: "Not yet open",
  open: "Open gig",
  filled: "Booked",
  expired: "Date passed",
  cancelled: "Cancelled",
};

const APPLICATION_STATUS_LABELS: Record<string, string> = {
  submitted: "Pending",
  withdrawn: "Withdrawn",
  declined: "Not selected",
  offered: "Offer sent",
};

const GIG_FORMAT_LABEL: Record<string, string> = {
  music: "Live music",
  comedy: "Comedy",
  either: "Music or comedy",
};

const ACT_KIND_LABEL: Record<string, string> = {
  band: "Band",
  solo: "Solo act",
  comedian: "Comedian",
  other: "Other act",
};

function friendlyLabel(labels: Record<string, string>, value: string) {
  return labels[value] ?? value.replaceAll("_", " ");
}

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
          {venue.name}{" "}
          <span className="badge">{GIG_FORMAT_LABEL[slot.format] ?? slot.format}</span>{" "}
          <span className="badge">{friendlyLabel(SLOT_STATUS_LABELS, slot.status)}</span>
        </h1>
        <p>
          {formatVenueDateTime(slot.startsAt, venue.timeZone, "full")}{" "}
          {shortTimeZoneName(slot.startsAt, venue.timeZone)}{" "}
          / {slot.durationMinutes} min /{" "}
          <span className="money">${(slot.budgetCents / 100).toFixed(0)}</span>
        </p>
        {slot.notes && <p>{slot.notes}</p>}
        <p className="muted">{formatAddress(venue)}</p>
        {venue.bio && <p className="muted">{venue.bio}</p>}
        <p className="muted">
          Sound: {venue.paInventory.hasPA ? "house PA" : "no house PA"} · Capacity:{" "}
          {venue.capacity ?? "not listed"}
        </p>
        {performer && !isOwner && slot.status === "open" && (
          myApplication?.status === "submitted" ? (
            <p>
              <span className="badge">Application sent</span>{" "}
              <ActionButton
                endpoint={`/api/applications/${myApplication.id}/status`}
                label="Withdraw application"
                body={{ action: "withdraw" }}
                confirm="Withdraw your application from this gig?"
              />
            </p>
          ) : myApplication ? (
            <p className="muted">
              Your application is {friendlyLabel(APPLICATION_STATUS_LABELS, myApplication.status).toLowerCase()}.
            </p>
          ) : (
            <div>
              <p className="muted">
                Your profile carries the essentials. Add a short note if there
                is something specific the venue should know.
              </p>
              <ApiForm
                endpoint={`/api/slots/${slot.id}/applications`}
                submitLabel="Apply for this gig"
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
        {!isOwner && slot.status === "open" && !performer && (
          <p className="muted">
            Want this gig?{" "}
            {userId ? (
              <Link href="/onboarding?role=performer">Create an act profile</Link>
            ) : (
              <>
                <Link href={`/login?next=${encodeURIComponent(`/slots/${slot.id}`)}`}>Sign in</Link>
                {" or "}
                <Link href="/onboarding?role=performer">create an act profile</Link>
              </>
            )}{" "}
            to apply.
          </p>
        )}
        {!isOwner && slot.status !== "open" && (
          <p className="muted">
            {slot.status === "filled"
              ? "This gig has been booked."
              : slot.status === "expired"
                ? "This date has passed."
                : slot.status === "cancelled"
                  ? "This gig was cancelled."
                  : "This gig is not accepting applications yet."}
          </p>
        )}
      </div>

      {isOwner && slot.status === "open" && (
        <div className="card">
          <h2>Manage this open date</h2>
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>Edit listing</summary>
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
              label="Close this listing"
              method="DELETE"
              confirm="Close this listing? It will no longer appear with open gigs. You can post a new date later."
            />{" "}
            <span className="muted">— removes it from open gigs; you can post a new date anytime.</span>
          </p>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <h2>Applicants ({applicants.length})</h2>
          {applicants.length === 0 && (
            <p className="muted">No applications yet. Share this listing or check back soon.</p>
          )}
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
              <span className="badge">{ACT_KIND_LABEL[p.kind] ?? "Act"}</span>{" "}
              <span className="badge" title="show-up history">{rel.label}</span>{" "}
              <span className="badge">
                {friendlyLabel(APPLICATION_STATUS_LABELS, application.status)}
              </span>{" "}
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
                    Pay, date, and duration match the public listing. This is one
                    firm offer; withdraw it before offering another act.{" "}
                    {paymentsEnabled()
                      ? "The contract and payment run through EightGig."
                      : "During beta, you and the act arrange payment directly. EightGig records the booking but does not process the payment."}
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
