import { db, schema } from "@gigit/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { publicMediaUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

const GEAR_LABEL: Record<string, string> = {
  none: "labor only — no rig",
  partial: "partial rig",
  full_rig: "full PA rig",
};

/** Public sound-tech page (PRD F1.4): gear, rates, travel. */
export default async function TechPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = db();
  const [t] = await d.select().from(schema.techs).where(eq(schema.techs.id, id));
  if (!t) notFound();
  const media = await d
    .select()
    .from(schema.mediaAssets)
    .where(and(
      eq(schema.mediaAssets.subjectType, "tech"),
      eq(schema.mediaAssets.subjectId, id),
      eq(schema.mediaAssets.status, "ready"),
    ))
    .orderBy(asc(schema.mediaAssets.position));
  const withUrls = await Promise.all(media.map(async (asset) => ({
    ...asset,
    url: asset.storageKey ? await publicMediaUrl(asset.storageKey) : null,
  })));

  const allReviews = await d
    .select({ review: schema.techSubslotReviews })
    .from(schema.techSubslotReviews)
    .innerJoin(
      schema.techSubslots,
      eq(schema.techSubslotReviews.subslotId, schema.techSubslots.id),
    )
    .where(eq(schema.techSubslots.techId, id))
    .orderBy(desc(schema.techSubslotReviews.createdAt));
  const reviewCutoff = Date.now() - 7 * 86_400_000;
  const visibleReviews = allReviews
    .map((row) => row.review)
    .filter((review) =>
      review.authorRole === "payer" &&
      (review.createdAt.getTime() < reviewCutoff ||
        allReviews.some((other) =>
          other.review.subslotId === review.subslotId &&
          other.review.authorRole === "tech",
        )),
    );
  const average = visibleReviews.length > 0
    ? visibleReviews.reduce((sum, review) => sum + (review.ratings.overall ?? 0), 0) /
      visibleReviews.length
    : null;

  return (
    <div>
      <div className="card">
        <h1>
          {t.name} <span className="badge">{GEAR_LABEL[t.gear] ?? t.gear}</span>
          {average !== null && (
            <> <span className="badge">★ {average.toFixed(1)} ({visibleReviews.length})</span></>
          )}
          {t.reliabilityStrikes > 0 && (
            <> <span className="badge">{t.reliabilityStrikes} cancellation{t.reliabilityStrikes === 1 ? "" : "s"}</span></>
          )}
        </h1>
        <p className="muted">Travels {t.travelRadiusKm} km</p>
        <p>{t.bio || <span className="muted">No bio yet.</span>}</p>
        <p className="muted">
          {t.rateLaborCents != null && (
            <>
              labor <span className="money">${(t.rateLaborCents / 100).toFixed(0)}</span>
            </>
          )}
          {t.rateWithRigCents != null && (
            <>
              {" "}
              · with rig{" "}
              <span className="money">${(t.rateWithRigCents / 100).toFixed(0)}</span>
            </>
          )}
          {t.rateLaborCents == null && t.rateWithRigCents == null && "Rates on request."}
        </p>
      </div>
      {withUrls.length > 0 && (
        <div className="card">
          {withUrls.map((asset) =>
            asset.kind === "image" && asset.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={asset.id}
                src={asset.url}
                alt={t.name}
                style={{ maxWidth: 180, marginRight: 8, borderRadius: 6 }}
              />
            ) : asset.kind === "audio" && asset.url ? (
              <audio key={asset.id} controls src={asset.url} />
            ) : null,
          )}
        </div>
      )}
      {visibleReviews.length > 0 && (
        <div className="card">
          <h2>Reviews from sound bookings</h2>
          {visibleReviews.map((review) => (
            <p key={review.id}>
              ★ {review.ratings.overall} —{" "}
              {review.body || <span className="muted">no comment</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
