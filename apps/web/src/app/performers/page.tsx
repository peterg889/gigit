import {
  ACT_KIND_LABEL,
  ACT_KIND_OPTIONS,
  GIG_FORMAT_LABEL,
} from "@/lib/labels";
import { performerReliability, SLOT_HOLDING_BOOKING_STATES } from "@gigit/domain";
import { db, performerReliabilityStats, schema } from "@gigit/db";
import { and, asc, eq, gte, inArray, notExists, sql } from "drizzle-orm";
import Link from "next/link";
import { profileCapabilitiesOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";
import { inviteSlotLabel } from "@/lib/invite-display";

export const dynamic = "force-dynamic";

/** Venue-facing performer search + invite (PRD F2.4). */
export default async function PerformerSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; genre?: string; metro?: string }>;
}) {
  const userId = await sessionUserId();
  const profiles = userId ? await profileCapabilitiesOwnedBy(userId) : null;
  const venue = profiles?.live.venue ?? null;
  const ownedVenue = profiles?.owned.venue ?? null;
  // An act reaching this page came through "Find an act" in the nav, which is
  // one of four discovery links and the only one that isn't theirs. Telling a
  // band to go set up a venue is a dead end; point them at the two pages that
  // are. (The gate itself stays: this page invites and messages acts, and only
  // a venue may open a conversation — F5.1, no cold DMs.)
  const act = profiles?.live.performer ?? profiles?.owned.performer ?? null;
  if (!venue)
    return (
      <div className="card">
        <h1>Find local acts</h1>
        {ownedVenue ? (
          <>
            <p>Your venue profile must be active to invite or message acts.</p>
            <Link href="/account">Review your account</Link>{" "}
            <Link href="/help">Contact support</Link>
          </>
        ) : act ? (
          <>
            <p>
              This page is how venues search for acts to book — so it's the one
              part of EightGig that isn't for you. Venues find you here when your
              act profile is live.
            </p>
            <Link className="btn" href="/slots">
              See open gigs
            </Link>{" "}
            <Link href="/venues">Browse the rooms</Link>
          </>
        ) : (
          <>
            <p>
              Create a venue profile to browse and contact local bands, solo acts,
              and comedians near you.
            </p>
            <Link className="btn" href="/onboarding?role=venue">
              Set up your venue
            </Link>{" "}
            {!userId && <Link href="/login">Sign in</Link>}
          </>
        )}
      </div>
    );

  const { kind, genre, metro } = await searchParams;
  const conditions = [
    eq(schema.performers.status, "live"),
    sql`exists (
      select 1 from ${schema.users}
      where ${schema.users.id} = ${schema.performers.ownerUserId}
        and ${schema.users.status} = 'active'
    )`,
  ];
  if (kind) conditions.push(eq(schema.performers.kind, kind));
  if (metro)
    conditions.push(eq(schema.performers.homeMetro, metro.trim().toLocaleLowerCase("en-US")));
  if (genre)
    conditions.push(
      sql`${schema.performers.genreTags} @> ${JSON.stringify([genre])}::jsonb`,
    );
  const d = db();
  const acts = await d
    .select()
    .from(schema.performers)
    .where(and(...conditions))
    .orderBy(asc(schema.performers.reliabilityStrikes), asc(schema.performers.createdAt))
    .limit(100);
  const relStats = await performerReliabilityStats(acts.map((p) => p.id));

  // The venue's own open nights, so an invite can name a real date instead of
  // pushing terms into a chat message.
  const myOpenSlots = venue
    ? await d
        .select({
          id: schema.slots.id,
          startsAt: schema.slots.startsAt,
          format: schema.slots.format,
          budgetCents: schema.slots.budgetCents,
        })
        .from(schema.slots)
        .where(
          and(
            eq(schema.slots.venueId, venue.id),
            eq(schema.slots.status, "open"),
            gte(schema.slots.startsAt, new Date()),
            notExists(
              d
                .select({ id: schema.bookings.id })
                .from(schema.bookings)
                .where(
                  and(
                    eq(schema.bookings.slotId, schema.slots.id),
                    inArray(schema.bookings.state, SLOT_HOLDING_BOOKING_STATES),
                  ),
                ),
            ),
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
            {ACT_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
        <div className="card">
          {/* This used to be one unconditional line: "No acts match those filters.
              Try removing one." With no acts on the platform yet, every venue was
              blamed for filters it never set — and the 48h `slot_quiet` nudge
              sends venues to exactly this page, so the only proactive touch the
              platform makes terminated in a dead end with no link out. */}
          {kind || genre || metro ? (
            <>
              <p>
                No acts match those filters.{" "}
                <Link href="/performers">Clear them</Link> to see everyone.
              </p>
              <p className="muted">
                It is still early here, so the roster is thin — widening the
                search is usually the fastest fix.
              </p>
            </>
          ) : (
            <>
              <p>No acts have joined yet.</p>
              <p className="muted">
                EightGig is new in this scene. Your open dates stay live and we
                will notify you the moment an act who fits posts a profile — you
                do not need to keep checking.
              </p>
              <p className="muted">
                Know someone who should be on here?{" "}
                <Link href="/help">Tell us who</Link> and we will invite them.
              </p>
            </>
          )}
        </div>
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
          <p className="muted user-text">{p.bio}</p>
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
                  defaultValue: "",
                  options: [
                    { value: "", label: "Choose an open date…" },
                    ...myOpenSlots.map((s) => ({
                      value: s.id,
                      label: inviteSlotLabel({
                        startsAt: s.startsAt,
                        timeZone: venue!.timeZone,
                        formatLabel: GIG_FORMAT_LABEL[s.format] ?? s.format,
                        budgetCents: s.budgetCents,
                      }),
                    })),
                  ],
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
