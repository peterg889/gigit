import { db, schema } from "@gigit/db";
import { and, asc, eq, gte } from "drizzle-orm";
import Link from "next/link";
import { performerOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

const GIG_FORMAT_LABEL: Record<string, string> = {
  music: "Live music",
  comedy: "Comedy",
  either: "Music or comedy",
};

const VENUE_KIND_LABEL: Record<string, string> = {
  bar: "Bar",
  restaurant: "Restaurant",
  coffee_shop: "Coffee shop",
  brewery: "Brewery",
  other: "Other venue",
};

function formatAreaName(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase("en-US"));
}

export default async function FeedPage() {
  const userId = await sessionUserId();
  const [performer, venue] = userId
    ? await Promise.all([performerOwnedBy(userId), venueOwnedBy(userId)])
    : [null, null];
  const searches = performer
    ? await db()
        .select()
        .from(schema.savedSearches)
        .where(eq(schema.savedSearches.performerId, performer.id))
    : [];
  const rows = await db()
    .select({
      slot: schema.slots,
      venueName: schema.venues.name,
      venueKind: schema.venues.kind,
      venueAddressLine1: schema.venues.addressLine1,
      venueAddressLine2: schema.venues.addressLine2,
      venueCity: schema.venues.city,
      venueRegion: schema.venues.region,
      venuePostalCode: schema.venues.postalCode,
      venueTimeZone: schema.venues.timeZone,
    })
    .from(schema.slots)
    .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
    .where(and(eq(schema.slots.status, "open"), gte(schema.slots.startsAt, new Date())))
    .orderBy(asc(schema.slots.startsAt))
    .limit(50);

  return (
    <div>
      <h1>Open gigs</h1>
      <p className="muted">
        Every gig shows its pay up front. Your act profile is your application,
        so applying takes one click.
      </p>
      {rows.length === 0 && (
        <div className="card">
          {venue ? (
            <>
              No open gigs yet. <Link href="/slots/new">Post your first open date</Link>
              — it takes about three minutes.
            </>
          ) : performer ? (
            <>No open gigs yet. Create an alert below and we&apos;ll let you know when one fits.</>
          ) : (
            <>
              No open gigs yet. Venues can <Link href="/onboarding?role=venue">post an open date</Link>.
            </>
          )}
        </div>
      )}
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
                  label="Remove"
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
              { name: "minBudgetCents", label: "Minimum pay (USD)", type: "number", placeholder: "200" },
            ]}
          />
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
            <span className="muted">({VENUE_KIND_LABEL[venueKind] ?? "Venue"})</span>
          </div>
          <div>
            {formatVenueDateTime(slot.startsAt, venueTimeZone)}{" "}
            {shortTimeZoneName(slot.startsAt, venueTimeZone)}{" "}
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
          {slot.notes && <div className="muted">{slot.notes}</div>}
        </div>
      ))}
    </div>
  );
}
