import { visibleReviews } from "@gigit/domain";
import { db, schema } from "@gigit/db";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { publicMediaUrl } from "@/lib/storage";
import { formatAddress, formatVenueDateTime, shortTimeZoneName } from "@/lib/date-time";

export const dynamic = "force-dynamic";

/** Public venue page: room, PA inventory, photos, open slots. */
export default async function VenuePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = db();
  const [v] = await d.select().from(schema.venues).where(eq(schema.venues.id, id));
  if (!v) notFound();

  const photos = await d
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.subjectType, "venue"),
        eq(schema.mediaAssets.subjectId, id),
        eq(schema.mediaAssets.status, "ready"),
        eq(schema.mediaAssets.kind, "image"),
      ),
    )
    .orderBy(asc(schema.mediaAssets.position));
  const photoUrls = await Promise.all(
    photos.map(async (m) => ({ id: m.id, url: await publicMediaUrl(m.storageKey!) })),
  );

  const openSlots = await d
    .select()
    .from(schema.slots)
    .where(
      and(
        eq(schema.slots.venueId, id),
        eq(schema.slots.status, "open"),
        gte(schema.slots.startsAt, new Date()),
      ),
    )
    .orderBy(asc(schema.slots.startsAt))
    .limit(20);

  // Reviews of this venue (authored by performers), same double-blind rule as
  // the performer page with the role flipped (PRD F7.1 — reviews cut both ways).
  const bookingsOfVenue = d
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .where(eq(schema.bookings.venueId, id));
  const allReviews = await d
    .select()
    .from(schema.reviews)
    .where(inArray(schema.reviews.bookingId, bookingsOfVenue))
    .orderBy(desc(schema.reviews.createdAt))
    .limit(50);
  const visible = visibleReviews(allReviews, "performer");
  const avg =
    visible.length > 0
      ? visible.reduce((s, r) => s + (r.ratings.overall ?? 0), 0) / visible.length
      : null;

  const pa = v.paInventory;
  return (
    <div>
      <div className="card">
        <h1>
          {v.name} <span className="badge">{v.kind.replace("_", " ")}</span>
          {v.reliabilityStrikes > 0 && (
            <> <span className="badge">{v.reliabilityStrikes} cancellation{v.reliabilityStrikes === 1 ? "" : "s"}</span></>
          )}
          {avg !== null && (
            <span className="badge">
              ★ {avg.toFixed(1)} ({visible.length})
            </span>
          )}
        </h1>
        <p className="muted">
          {formatAddress(v)} · {v.metro} · capacity {v.capacity ?? "?"}
          {v.noiseCurfew && <> · curfew {v.noiseCurfew}</>}
        </p>
        <p>{v.bio || <span className="muted">No description yet.</span>}</p>
        <p className="muted">
          Sound:{" "}
          {pa.hasPA
            ? `house PA (${pa.mixerChannels ?? "?"} ch, ${pa.micsAvailable ?? 0} mics, ${pa.monitors ?? 0} monitors${pa.hasOperator ? ", operated" : ", unstaffed"})`
            : "no house PA — bring your own or book a tech"}
        </p>
      </div>

      {photoUrls.length > 0 && (
        <div className="card">
          {photoUrls.map((m) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={m.id}
              src={m.url}
              alt={v.name}
              style={{ maxWidth: 160, marginRight: 8, borderRadius: 6 }}
            />
          ))}
        </div>
      )}

      <div className="card">
        <h2>Open slots</h2>
        {openSlots.length === 0 && <p className="muted">Nothing open right now.</p>}
        {openSlots.map((s) => (
          <p key={s.id}>
            <Link href={`/slots/${s.id}`}>
              {formatVenueDateTime(s.startsAt, v.timeZone)}{" "}
              {shortTimeZoneName(s.startsAt, v.timeZone)}
            </Link>{" "}
            · <span className="badge">{s.format}</span> ·{" "}
            <span className="money">${(s.budgetCents / 100).toFixed(0)}</span>
          </p>
        ))}
      </div>

      {visible.length > 0 && (
        <div className="card">
          <h2>Reviews from performers</h2>
          {visible.map((r) => (
            <p key={r.id}>
              ★ {r.ratings.overall} —{" "}
              {r.body || <span className="muted">no comment</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
