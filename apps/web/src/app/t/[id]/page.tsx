import { visibleReviews } from "@gigit/domain";
import { db, schema } from "@gigit/db";
import { and, asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { publicMediaUrl } from "@/lib/storage";
import { GEAR_LABELS } from "@/lib/labels";
import { averageOverall } from "@/lib/review-display";
import { profileMetadata } from "@/lib/profile-metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [row] = await db()
    .select({ name: schema.techs.name, bio: schema.techs.bio, status: schema.techs.status })
    .from(schema.techs)
    .where(eq(schema.techs.id, id));
  return profileMetadata(row, "live sound engineer on EightGig.");
}

/** Public sound-tech page (PRD F1.4): gear, rates, travel. */
export default async function TechPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = db();
  const [t] = await d.select().from(schema.techs).where(eq(schema.techs.id, id));
  // A hidden profile (owner deactivated or suspended) must not be served. The
  // act and venue pages have always had this gate; the tech page was a
  // copy-paste that predated it, so setProfileVisibility wrote techs.status and
  // nothing ever read it — a suspended tech's name, rates, and photos stayed up.
  if (!t || t.status !== "live") notFound();
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
  // This reimplemented the double-blind rule in a local const that SHADOWED the
  // domain export, hardcoding the 7-day window — so changing
  // REVIEW_VISIBILITY_DAYS would have taken tech reviews public early while act
  // and venue reviews held. Same rule, one implementation, keyed on the
  // sub-slot's own author roles.
  const visible = visibleReviews(
    allReviews.map((row) => ({
      bookingId: row.review.subslotId,
      authorRole: row.review.authorRole,
      createdAt: row.review.createdAt,
      ratings: row.review.ratings,
      body: row.review.body,
      id: row.review.id,
    })),
    "payer",
  );
  const average = averageOverall(visible);

  return (
    <div>
      <div className="card">
        <h1>
          {t.name}{" "}
          <span className="badge">{GEAR_LABELS[t.gear] ?? "Equipment not listed"}</span>
          {average !== null && (
            <> <span className="badge">★ {average.toFixed(1)} ({visible.length})</span></>
          )}
          {t.reliabilityStrikes > 0 && (
            <> <span className="badge">{t.reliabilityStrikes} cancellation{t.reliabilityStrikes === 1 ? "" : "s"}</span></>
          )}
        </h1>
        <p className="muted">Travels {t.travelRadiusMiles} miles</p>
        <p>{t.bio || <span className="muted">No experience summary yet.</span>}</p>
        <p className="muted">
          {t.rateLaborCents != null && (
            <>
              Labor: <span className="money">${(t.rateLaborCents / 100).toFixed(0)}</span>
            </>
          )}
          {t.rateLaborCents != null && t.rateWithRigCents != null && " · "}
          {t.rateWithRigCents != null && (
            <>
              With rig:{" "}
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
      {visible.length > 0 && (
        <div className="card">
          <h2>Reviews from sound bookings</h2>
          {visible.map((review) => (
            <p key={review.id}>
              ★ {review.ratings.overall} —{" "}
              {review.body || <span className="muted">No written comment.</span>}
            </p>
          ))}
        </div>
      )}
      <p><Link href="/techs">Browse sound techs</Link></p>
    </div>
  );
}
