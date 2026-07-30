import { db, schema } from "@gigit/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";

import { formatAreaName } from "@/lib/date-time";
import { VENUE_KIND_LABEL } from "@/lib/labels";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Rooms that book live music — EightGig",
  description:
    "Small rooms in the scene, with capacity, house PA, and curfew listed — so you know what you're walking into before you apply.",
};

/**
 * The rooms directory (PRD F2.4, act side).
 *
 * An act's day one used to be an empty feed and nothing else: they couldn't
 * browse venues (`/performers` is venue-gated), `/v/[id]` was linked from one
 * place in the entire product, and cold-messaging a venue is deliberately not
 * allowed. So there was no single-sided value on the side with the most
 * profiles and the fewest slots. This is read-only on purpose — no contact
 * affordance, so the no-cold-DM policy (F5.1) stays intact.
 */
export default async function VenuesPage() {
  const d = db();
  const rooms = await d
    .select({
      venue: schema.venues,
      openSlots: sql<number>`(
        select count(*)::int from ${schema.slots}
         where ${schema.slots.venueId} = ${schema.venues.id}
           and ${schema.slots.status} = 'open'
           and ${schema.slots.startsAt} >= now()
      )`,
    })
    .from(schema.venues)
    .where(eq(schema.venues.status, "live"))
    .orderBy(asc(schema.venues.name))
    .limit(100);

  return (
    <div>
      <span className="eyebrow">The rooms</span>
      <h1>Rooms that book live music</h1>
      <p className="lede">
        What the room actually is — how many it holds, what the PA is, when the
        noise has to stop. Worth reading before you apply, not after.
      </p>

      {rooms.length === 0 && (
        <div className="card">
          <p>No rooms listed yet.</p>
          <p className="muted">
            If you run one, <Link href="/onboarding?role=venue">add it</Link> — the
            first rooms on EightGig become Founding Members.
          </p>
        </div>
      )}

      {rooms.map(({ venue: v, openSlots }) => {
        const pa = v.paInventory;
        return (
          <div className="card" key={v.id}>
            <div>
              <strong>
                <Link href={`/v/${v.id}`}>{v.name}</Link>
              </strong>{" "}
              <span className="badge">{VENUE_KIND_LABEL[v.kind] ?? "Venue"}</span>{" "}
              {v.foundingMember && <span className="badge">Founding Member</span>}{" "}
              {v.reliabilityStrikes > 0 && (
                <span className="badge bad">
                  {v.reliabilityStrikes} cancellation
                  {v.reliabilityStrikes === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="gig-line">
              {formatAreaName(v.metro)}
              {v.capacity != null && <> · holds {v.capacity}</>}
              {v.noiseCurfew && <> · curfew {v.noiseCurfew}</>}
            </div>
            <p className="muted">
              {pa.hasPA
                ? `House PA${
                    pa.mixerChannels != null ? ` · ${pa.mixerChannels} channels` : ""
                  }${pa.hasOperator ? " · house sound tech" : " · no house tech"}`
                : "No house PA — bring your own or find a tech"}
            </p>
            <p>
              {openSlots > 0 ? (
                <Link href={`/v/${v.id}`}>
                  {openSlots} open {openSlots === 1 ? "night" : "nights"} — see the
                  dates
                </Link>
              ) : (
                <span className="muted">
                  No open nights right now.{" "}
                  <Link href={`/v/${v.id}`}>See the room</Link>.
                </span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
