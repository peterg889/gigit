import { performerReliability, visibleReviews } from "@gigit/domain";
import { db, performerReliabilityStats, schema } from "@gigit/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { publicMediaUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Public performer EPK: bio, photos, audio, video embeds, reviews. */
export default async function PerformerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = db();
  const [p] = await d.select().from(schema.performers).where(eq(schema.performers.id, id));
  if (!p) notFound();

  const media = await d
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.subjectType, "performer"),
        eq(schema.mediaAssets.subjectId, id),
        eq(schema.mediaAssets.status, "ready"),
      ),
    )
    .orderBy(asc(schema.mediaAssets.position));

  // Reviews of this performer (authored by venues), double-blind rule:
  // visible once both sides reviewed or 7 days after submission (PRD F7.1).
  const bookingsOfPerformer = d
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .where(eq(schema.bookings.performerId, id));
  const allReviews = await d
    .select()
    .from(schema.reviews)
    .where(inArray(schema.reviews.bookingId, bookingsOfPerformer))
    .orderBy(desc(schema.reviews.createdAt))
    .limit(50);
  const visible = visibleReviews(allReviews, "venue");
  const avg =
    visible.length > 0
      ? visible.reduce((s, r) => s + (r.ratings.overall ?? 0), 0) / visible.length
      : null;

  // Reliability badge (PRD F7.3): the trust signal that matters most with
  // payments deferred — does this act show up?
  const rel = performerReliability(
    (await performerReliabilityStats([id])).get(id) ?? {
      gigsCompleted: 0,
      cancellations: 0,
    },
  );

  const mediaWithUrls = await Promise.all(
    media.map(async (m) => ({
      ...m,
      url: m.storageKey ? await publicMediaUrl(m.storageKey) : null,
    })),
  );
  const images = mediaWithUrls.filter((m) => m.kind === "image");
  const audio = mediaWithUrls.filter((m) => m.kind === "audio");
  const embeds = mediaWithUrls.filter((m) => m.kind === "video_embed");

  return (
    <div>
      <div className="card">
        <h1>
          {p.name} <span className="badge">{p.kind}</span>{" "}
          <span className="badge" title="show-up history">{rel.label}</span>
          {avg !== null && (
            <span className="badge">
              ★ {avg.toFixed(1)} ({visible.length})
            </span>
          )}
        </h1>
        <p className="muted">
          {p.homeMetro} · travels {p.travelRadiusKm} km
          {p.genreTags.length > 0 && <> · {p.genreTags.join(", ")}</>}
        </p>
        <p>{p.bio}</p>
        {p.rateMinCents != null && p.rateMaxCents != null && (
          <p className="muted">
            Typical rate:{" "}
            <span className="money">
              ${(p.rateMinCents / 100).toFixed(0)}–$
              {(p.rateMaxCents / 100).toFixed(0)}
            </span>
          </p>
        )}
      </div>

      {images.length > 0 && (
        <div className="card">
          {images.map((m) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={m.id}
              src={m.url!}
              alt={p.name}
              style={{ maxWidth: 160, marginRight: 8, borderRadius: 6 }}
            />
          ))}
        </div>
      )}

      {audio.length > 0 && (
        <div className="card">
          <h2>Listen</h2>
          {audio.map((m) => (
            <audio key={m.id} controls src={m.url!} />
          ))}
        </div>
      )}

      {embeds.length > 0 && (
        <div className="card">
          <h2>Watch</h2>
          {embeds.map((m) => (
            <p key={m.id}>
              <a href={m.embedUrl!} target="_blank" rel="noreferrer">
                ▶ {m.embedMeta?.title ?? m.embedUrl}
              </a>{" "}
              <span className="badge">{m.embedMeta?.provider}</span>
            </p>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <div className="card">
          <h2>Reviews from venues</h2>
          {visible.map((r) => (
            <p key={r.id}>
              ★ {r.ratings.overall} — {r.body || <span className="muted">no comment</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
