import { ACT_KIND_LABEL } from "@/lib/labels";
import { performerReliability } from "@gigit/domain";
import { db, performerReliabilityStats, schema } from "@gigit/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";
import { formatVenueDate } from "@/lib/date-time";

export const dynamic = "force-dynamic";

/** Venue-facing performer search + invite (PRD F2.4). */
export default async function PerformerSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; genre?: string; metro?: string }>;
}) {
  const userId = await sessionUserId();
  const venue = userId ? await venueOwnedBy(userId) : null;
  if (!venue)
    return (
      <div className="card">
        <h1>Find local acts</h1>
        <p>
          Create a venue profile to browse and contact local bands, solo acts,
          and comedians near you.
        </p>
        <Link className="btn" href="/onboarding?role=venue">
          Set up your venue
        </Link>{" "}
        <Link href="/login">Sign in</Link>
      </div>
    );

  const { kind, genre, metro } = await searchParams;
  const conditions = [eq(schema.performers.status, "live")];
  if (kind) conditions.push(eq(schema.performers.kind, kind));
  if (metro)
    conditions.push(eq(schema.performers.homeMetro, metro.trim().toLocaleLowerCase("en-US")));
  if (genre)
    conditions.push(
      sql`${schema.performers.genreTags} @> ${JSON.stringify([genre])}::jsonb`,
    );
  const acts = await db()
    .select()
    .from(schema.performers)
    .where(and(...conditions))
    .orderBy(asc(schema.performers.reliabilityStrikes), asc(schema.performers.createdAt))
    .limit(100);
  const relStats = await performerReliabilityStats(acts.map((p) => p.id));

  // The venue's own open nights, so an invite can name a real date instead of
  // pushing terms into a chat message.
  const myOpenSlots = venue
    ? await db()
        .select({
          id: schema.slots.id,
          startsAt: schema.slots.startsAt,
          budgetCents: schema.slots.budgetCents,
        })
        .from(schema.slots)
        .where(
          and(
            eq(schema.slots.venueId, venue.id),
            eq(schema.slots.status, "open"),
            gte(schema.slots.startsAt, new Date()),
          ),
        )
        .orderBy(asc(schema.slots.startsAt))
        .limit(20)
    : [];

  return (
    <div>
      <h1>Find an act</h1>
      <p className="muted">
        Compare local acts by type, genre, typical rate, and verified show-up
        history. Message anyone who looks right for your room.
      </p>
      <div className="card">
        <form method="get">
          <label htmlFor="kind">Type</label>
          <select id="kind" name="kind" defaultValue={kind ?? ""}>
            <option value="">Any</option>
            {["band", "solo", "comedian", "other"].map((k) => (
              <option key={k} value={k}>
                {ACT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <label htmlFor="genre">Genre</label>
          <input id="genre" name="genre" defaultValue={genre ?? ""} placeholder="e.g. folk" />
          <label htmlFor="metro">City or metro area</label>
          <input id="metro" name="metro" defaultValue={metro ?? ""} placeholder="e.g. Milwaukee" />
          <button>Search</button>
        </form>
      </div>
      {acts.length === 0 && (
        <div className="card">No acts match those filters. Try removing one.</div>
      )}
      {acts.map((p) => {
        const rel = performerReliability(
          relStats.get(p.id) ?? { gigsCompleted: 0, cancellations: 0 },
        );
        return (
        <div className="card" key={p.id}>
          <strong>
            <Link href={`/p/${p.id}`}>{p.name}</Link>
          </strong>{" "}
          <span className="badge">{ACT_KIND_LABEL[p.kind] ?? "Act"}</span>{" "}
          <span className="badge" title="show-up history">{rel.label}</span>
          {p.genreTags.length > 0 && (
            <span className="muted"> · {p.genreTags.join(", ")}</span>
          )}
          <p className="muted">{p.bio}</p>
          {p.rateMinCents != null && p.rateMaxCents != null && (
            <p className="muted">
              Typical rate:{" "}
              <span className="money">
                ${(p.rateMinCents / 100).toFixed(0)}–${(p.rateMaxCents / 100).toFixed(0)}
              </span>
            </p>
          )}
          {/* Invite them to a real date, on the offer rail. The two nudges that
              tell venues to "send an invite" used to land on the message box
              below, which pushed the terms into chat and then made the act go
              find the slot and apply before an offer was even possible. */}
          {myOpenSlots.length > 0 && (
            <ApiForm
              endpoint="/api/slots/:slotId/invite"
              submitLabel={`Invite ${p.name} to a date`}
              redirectTo="/bookings"
              fields={[
                {
                  name: "slotId",
                  label: "Which night?",
                  type: "select",
                  required: true,
                  options: myOpenSlots.map((s) => ({
                    value: s.id,
                    label: `${formatVenueDate(s.startsAt, venue!.timeZone)} — $${(
                      s.budgetCents / 100
                    ).toFixed(0)}`,
                  })),
                },
              ]}
              extra={{ performerId: p.id }}
            />
          )}
          <details>
            <summary className="muted">Or just send a message</summary>
            <ApiForm
              endpoint="/api/threads"
              submitLabel="Message this act"
              redirectTo="/inbox"
              fields={[
                {
                  name: "body",
                  label: `Message ${p.name}`,
                  type: "textarea",
                  required: true,
                  placeholder: "Anything they should know about the room?",
                },
              ]}
              extra={{ performerId: p.id }}
            />
          </details>
        </div>
        );
      })}
    </div>
  );
}
