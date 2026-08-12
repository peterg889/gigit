import { db, openSlotFeed, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { profileCapabilitiesOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatAreaName,
  formatVenueDateTimeWithZone,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

import { GIG_FORMAT_LABEL, VENUE_KIND_LABEL } from "@/lib/labels";

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ format?: string; metro?: string }>;
}) {
  const query = await searchParams;
  // "Live music" includes either-format nights (a band can play them); same
  // for comedy. The chips filter what an act can actually take.
  const formatFilter =
    query.format === "music" || query.format === "comedy" ? query.format : null;
  const metroFilter = query.metro?.trim().toLocaleLowerCase("en-US") || null;
  const userId = await sessionUserId();
  const profiles = userId ? await profileCapabilitiesOwnedBy(userId) : null;
  const performer = profiles?.live.performer ?? null;
  const venue = profiles?.live.venue ?? null;
  const ownedPerformer = profiles?.owned.performer ?? null;
  const ownedVenue = profiles?.owned.venue ?? null;
  const searches = performer
    ? await db()
        .select()
        .from(schema.savedSearches)
        .where(eq(schema.savedSearches.performerId, performer.id))
    : [];
  const rows = await openSlotFeed({
    format: formatFilter,
    metro: metroFilter,
    limit: 50,
  });

  const chipHref = (format: string | null) => {
    const params = new URLSearchParams();
    if (format) params.set("format", format);
    if (metroFilter) params.set("metro", metroFilter);
    const qs = params.toString();
    return qs ? `/slots?${qs}` : "/slots";
  };

  return (
    <div>
      <h1>Open gigs</h1>
      <p className="muted">
        Every gig shows its listed budget up front. Venues and acts settle the
        agreed pay directly; your act profile makes applying one click.
      </p>
      <div className="filter-row">
        {(
          [
            [null, "All gigs"],
            ["music", "Live music"],
            ["comedy", "Comedy"],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={label}
            className={`filter-chip${formatFilter === value ? " on" : ""}`}
            href={chipHref(value)}
          >
            {label}
          </Link>
        ))}
        <form method="get" action="/slots" className="filter-form">
          {formatFilter && <input type="hidden" name="format" value={formatFilter} />}
          <input
            type="text"
            name="metro"
            defaultValue={query.metro ?? ""}
            placeholder="City or metro area"
            aria-label="Filter by city or metro area"
          />
          <button className="quiet" type="submit">Filter</button>
        </form>
      </div>
      {rows.length === 0 && (formatFilter || metroFilter) && (
        <div className="card">
          <p>
            No open gigs match these filters.{" "}
            <Link href="/slots">Clear filters</Link> to see everything.
          </p>
          {/* The alerts card is gated on `performer`, so promising "save an alert
              below" to a venue or a signed-out visitor pointed at nothing. */}
          {performer ? (
            <p className="muted">
              Or save an alert below and we&apos;ll notify you when one fits.
            </p>
          ) : (
            <p className="muted">
              <Link href="/venues">Browse the rooms</Link> in the meantime —
              capacity and PA specs are listed whether or not they have a date up.
            </p>
          )}
        </div>
      )}
      {rows.length === 0 && !formatFilter && !metroFilter && (
        <div className="card">
          {venue ? (
            <>
              No open gigs yet. <Link href="/slots/new">Post your first open date</Link>
              — it takes about three minutes.
            </>
          ) : performer ? (
            <>
              <p>
                No open gigs yet — EightGig is new here, so the board fills up as
                rooms come on.
              </p>
              <p className="muted">
                Save an alert below and we&apos;ll notify you the moment one fits.
                Meanwhile <Link href="/venues">have a look at the rooms</Link> —
                capacity, house PA, and curfew are listed for each.
              </p>
            </>
          ) : ownedPerformer || ownedVenue ? (
            <>
              <p>Your marketplace profile is not active right now.</p>
              <p className="muted">
                <Link href="/account">Review your account</Link> or contact support.
              </p>
            </>
          ) : (
            /* The fallback branch. It used to say "Venues can post an open date",
               which addresses a venue — but this is the page an ACT lands on, and
               an act cannot post one. Offer the thing they can actually do. */
            <>
              <p>
                No open gigs yet — EightGig is new here, so the board fills up as
                rooms come on.
              </p>
              <p className="muted">
                <Link href="/venues">Browse the rooms</Link> to see who books live
                music near you, or{" "}
                <Link href="/onboarding?role=performer">set up your act</Link> so
                you can save a gig alert.
              </p>
              <p className="muted">
                Run a room?{" "}
                <Link href="/onboarding?role=venue">Post your first open date</Link>.
              </p>
            </>
          )}
        </div>
      )}
      {rows.map(({
        slot,
        venueName,
        venueKind,
        venueAddressLine1,
        venueAddressLine2,
        venueCity,
        venueRegion,
        venuePostalCode,
        venueTimeZone,
      }) => (
        <div className="card" key={slot.id}>
          <div>
            <span className="badge">{GIG_FORMAT_LABEL[slot.format] ?? slot.format}</span>{" "}
            {slot.seriesId && <span className="badge">Recurring</span>}{" "}
            <strong>
              <Link href={`/slots/${slot.id}`}>{venueName}</Link>
            </strong>{" "}
            {/* The room itself was reachable from exactly one place in the whole
                product — the venue's own "view public page" link. So an act could
                never read the PA specs, the capacity, or the reviews of the room
                they were about to apply to. */}
            <Link className="muted" href={`/v/${slot.venueId}`}>
              ({VENUE_KIND_LABEL[venueKind] ?? "Venue"} · about this room)
            </Link>
          </div>
          <div>
            {formatVenueDateTimeWithZone(slot.startsAt, venueTimeZone)}{" "}
            · {slot.durationMinutes} min ·{" "}
            <span className="money">${(slot.budgetCents / 100).toFixed(0)}</span>
          </div>
          <div className="muted">
            {formatAddress({
              addressLine1: venueAddressLine1,
              addressLine2: venueAddressLine2,
              city: venueCity,
              region: venueRegion,
              postalCode: venuePostalCode,
            })}
          </div>
          {slot.notes && <div className="muted user-text">{slot.notes}</div>}
        </div>
      ))}
      {performer && (
        <div className="card">
          <h2>Gig alerts</h2>
          {searches.length === 0 ? (
            <p className="muted">
              Save a search and we&apos;ll notify you when a matching gig is posted.
              Leave a field blank to match anything.
            </p>
          ) : (
            searches.map((s) => (
              <p key={s.id}>
                <span className="badge">
                  {s.format ? GIG_FORMAT_LABEL[s.format] ?? s.format : "Any format"}
                </span>{" "}
                <span className="badge">
                  {s.metro ? formatAreaName(s.metro) : "Any city or area"}
                </span>{" "}
                {s.minBudgetCents != null && (
                  <span className="money">${(s.minBudgetCents / 100).toFixed(0)}+</span>
                )}{" "}
                <ActionButton
                  endpoint={`/api/saved-searches/${s.id}`}
                  label="Remove" variant="quiet"
                  method="DELETE"
                />
              </p>
            ))
          )}
          <ApiForm
            endpoint="/api/saved-searches"
            submitLabel="Save alert"
            fields={[
              { name: "format", label: "Format", type: "select", options: ["", "music", "comedy", "either"] },
              { name: "metro", label: "City or metro area", placeholder: "e.g. Milwaukee" },
              { name: "minBudgetCents", label: "Lowest pay you want to hear about, in dollars", type: "number" },
            ]}
          />
        </div>
      )}
    </div>
  );
}
