import { performerReliability, visibleReviews } from "@gigit/domain";
import {
  db,
  performerReliabilityStats,
  reviewableProfileReviews,
  schema,
} from "@gigit/db";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sessionUserId } from "@/lib/session";
import { ACT_KIND_LABEL } from "@/lib/labels";
import { formatAreaName } from "@/lib/date-time";
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
    .select({ name: schema.performers.name, bio: schema.performers.bio, status: schema.performers.status })
    .from(schema.performers)
    .where(eq(schema.performers.id, id));
  return profileMetadata(row, "live act on EightGig.");
}

const MEDIA_PROVIDER_LABEL: Record<string, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  bandcamp: "Bandcamp",
  soundcloud: "SoundCloud",
  flickr: "Flickr",
  imgur: "Imgur",
};

interface MediaLinkAsset {
  id: string;
  embedUrl: string;
  embedMeta: { title?: string; provider?: string } | null;
}

/**
 * A track or a video is a link out, badged with the host it lives on. We store
 * a URL and whatever metadata the provider volunteered — never the provider's
 * embed HTML — so there is no markup of theirs to inject here, and hand-building
 * player URLs would be a second allow-list to keep honest against the first.
 */
function MediaLink({ asset, icon }: { asset: MediaLinkAsset; icon: string }) {
  const provider = asset.embedMeta?.provider?.toLowerCase();
  return (
    <p>
      <a href={asset.embedUrl} target="_blank" rel="noreferrer">
        {icon} {asset.embedMeta?.title ?? asset.embedUrl}
      </a>{" "}
      {provider && (
        <span className="badge">{MEDIA_PROVIDER_LABEL[provider] ?? provider}</span>
      )}
    </p>
  );
}

/** Public performer EPK: bio, photo/audio/video links, reviews. */
export default async function PerformerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = db();
  const [p] = await d.select().from(schema.performers).where(eq(schema.performers.id, id));
  // A hidden profile (owner deactivated or suspended) must not be served —
  // these pages publish an EPK and, for venues, a full street address.
  if (!p || p.status !== "live") notFound();

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
  const allReviews = await reviewableProfileReviews({ kind: "performer", id });
  const visible = visibleReviews(allReviews, "venue");
  const avg = averageOverall(visible);

  // Reliability badge (PRD F7.3): the trust signal that matters most with
  // payments deferred — does this act show up?
  const rel = performerReliability(
    (await performerReliabilityStats([id])).get(id) ?? {
      gigsCompleted: 0,
      cancellations: 0,
    },
  );

  const photos = media.filter((m) => m.kind === "photo");
  const audio = media.filter((m) => m.kind === "audio");
  const videos = media.filter((m) => m.kind === "video");

  // This is the page an act SENDS to a venue. A new one used to open with two
  // apologies — "has not added a bio yet", "has not added photos, audio, video,
  // or reviews yet" — which is the worst possible thing to say to the person
  // deciding whether to book them. Nobody but the owner can act on either, so
  // only the owner is told; a visitor sees what's there and nothing about what
  // isn't.
  const isOwner = (await sessionUserId()) === p.ownerUserId;
  const nothingToShow =
    photos.length === 0 &&
    audio.length === 0 &&
    videos.length === 0 &&
    visible.length === 0;

  return (
    <div>
      <div className="card">
        <h1>
          {p.name}{" "}
          <span className="badge">{ACT_KIND_LABEL[p.kind] ?? "Act"}</span>{" "}
          {p.foundingMember && (
            <span className="badge" title="One of the first acts on EightGig">
              Founding Member
            </span>
          )}{" "}
          <span className="badge" title="show-up history">{rel.label}</span>
          {avg !== null && (
            <span className="badge">
              ★ {avg.toFixed(1)} ({visible.length})
            </span>
          )}
        </h1>
        <p className="muted">
          {formatAreaName(p.homeMetro)} · travels {p.travelRadiusMiles} miles
          {p.genreTags.length > 0 && <> · {p.genreTags.join(", ")}</>}
        </p>
        {p.bio ? (
          <p className="user-text">{p.bio}</p>
        ) : (
          isOwner && (
            <p className="muted">
              No bio yet — <Link href="/me">add a few lines</Link> so a booker
              knows who they&rsquo;re looking at.
            </p>
          )
        )}
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

      {nothingToShow && isOwner && (
        <div className="card">
          <p>
            This is the page you send to a venue, and right now it&rsquo;s just
            words. A photo and one track do more than any bio.
          </p>
          <Link className="btn" href="/me">
            Link a photo, a track, or a video
          </Link>
        </div>
      )}

      {photos.length > 0 && (
        <div className="card">
          {photos.map((m) => {
            // imageUrl and thumbnailUrl only ever hold the provider's own
            // allow-listed CDN host (lib/oembed drops anything else), which is
            // what makes it safe to put one in an <img src> on a page anyone can
            // load. A photo host that volunteered neither still leaves us a link
            // worth following — better than an <img> pointed at a page of HTML.
            const src = m.embedMeta?.imageUrl ?? m.embedMeta?.thumbnailUrl;
            return src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={m.id}
                src={src}
                alt={m.embedMeta?.title ?? p.name}
                style={{ maxWidth: 160, marginRight: 8, borderRadius: 6 }}
              />
            ) : (
              <MediaLink key={m.id} asset={m} icon="▣" />
            );
          })}
        </div>
      )}

      {audio.length > 0 && (
        <div className="card">
          <h2>Listen</h2>
          {audio.map((m) => (
            <MediaLink key={m.id} asset={m} icon="♪" />
          ))}
        </div>
      )}

      {videos.length > 0 && (
        <div className="card">
          <h2>Watch</h2>
          {videos.map((m) => (
            <MediaLink key={m.id} asset={m} icon="▶" />
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <div className="card">
          <h2>Reviews from venues</h2>
          {visible.map((r) => (
            <p key={r.id}>
              ★ {r.ratings.overall} —{" "}
              {r.body ? (
                <span className="user-text">{r.body}</span>
              ) : (
                <span className="muted">No written comment.</span>
              )}
            </p>
          ))}
        </div>
      )}
      <p><Link href="/performers">Browse more local acts</Link></p>
    </div>
  );
}
