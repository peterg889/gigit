import { db, schema } from "@gigit/db";
import { and, asc, eq, gte } from "drizzle-orm";
import Link from "next/link";
import { performerOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm } from "@/components/ApiForm";
import {
  formatAddress,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const userId = await sessionUserId();
  const performer = userId ? await performerOwnedBy(userId) : null;
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
      <h1>Open slots</h1>
      <p className="muted">
        Every slot shows its pay up front. Your profile is the application — one
        tap and you&apos;re in.
      </p>
      {rows.length === 0 && (
        <div className="card">
          Nothing on the board yet. Venues:{" "}
          <Link href="/slots/new">post the first slot</Link> — it takes three
          minutes.
        </div>
      )}
      {performer && (
        <div className="card">
          <h2>Slot alerts</h2>
          {searches.length === 0 ? (
            <p className="muted">
              Save a search and we&apos;ll notify you the moment a matching slot
              posts. Leave a field blank to match anything.
            </p>
          ) : (
            searches.map((s) => (
              <p key={s.id}>
                <span className="badge">{s.format ?? "any format"}</span>{" "}
                <span className="badge">{s.metro ?? "any metro"}</span>{" "}
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
              { name: "metro", label: "Metro", placeholder: "e.g. milwaukee" },
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
            <span className="badge">{slot.format}</span>{" "}
            {slot.seriesId && <span className="badge">recurring</span>}{" "}
            <strong>
              <Link href={`/slots/${slot.id}`}>{venueName}</Link>
            </strong>{" "}
            <span className="muted">({venueKind.replace("_", " ")})</span>
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
