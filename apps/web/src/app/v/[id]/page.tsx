import { db, schema } from "@gigit/db";
import { and, asc, eq, gte } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { localPublicPath } from "@/lib/storage";

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

  const pa = v.paInventory;
  return (
    <div>
      <div className="card">
        <h1>
          {v.name} <span className="badge">{v.kind.replace("_", " ")}</span>
        </h1>
        <p className="muted">
          {v.metro} · capacity {v.capacity ?? "?"}
          {v.noiseCurfew && <> · curfew {v.noiseCurfew}</>}
        </p>
        <p>{v.bio}</p>
        <p className="muted">
          Sound:{" "}
          {pa.hasPA
            ? `house PA (${pa.mixerChannels ?? "?"} ch, ${pa.micsAvailable ?? 0} mics, ${pa.monitors ?? 0} monitors${pa.hasOperator ? ", operated" : ", unstaffed"})`
            : "no house PA — bring your own or book a tech"}
        </p>
      </div>

      {photos.length > 0 && (
        <div className="card">
          {photos.map((m) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={m.id}
              src={localPublicPath(m.storageKey!)}
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
              {s.startsAt.toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
              })}
            </Link>{" "}
            · <span className="badge">{s.format}</span> · $
            {(s.budgetCents / 100).toFixed(0)}
          </p>
        ))}
      </div>
    </div>
  );
}
