import { db, schema } from "@gigit/db";
import { and, asc, eq } from "drizzle-orm";
import type { MediaItem } from "@/components/MediaManager";

/**
 * Everything attached to one of the caller's OWN profiles, in the order the
 * profile page would show it.
 *
 * Unlike the public /p, /v and /t queries this deliberately does not filter on
 * status: an owner has to be able to see the link that is still being screened
 * and the one a moderator refused, or "remove one to add another" is advice
 * about rows they cannot see. The per-kind quotas cap this at 35 rows, so it
 * needs no LIMIT — and must not have one, since a cap that clipped the list
 * would hide exactly the row someone is trying to delete.
 */
export async function ownedMedia(
  subjectType: "performer" | "venue" | "tech",
  subjectId: string,
): Promise<MediaItem[]> {
  const rows = await db()
    .select({
      id: schema.mediaAssets.id,
      kind: schema.mediaAssets.kind,
      embedUrl: schema.mediaAssets.embedUrl,
      embedMeta: schema.mediaAssets.embedMeta,
      status: schema.mediaAssets.status,
    })
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.subjectType, subjectType),
        eq(schema.mediaAssets.subjectId, subjectId),
      ),
    )
    .orderBy(asc(schema.mediaAssets.kind), asc(schema.mediaAssets.position));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as MediaItem["kind"],
    // The provider's title when oEmbed gave us one. A bare URL is a poor label
    // but it is the only thing that distinguishes two videos from each other
    // when the fetch failed, and the owner needs to tell them apart to pick the
    // one to remove.
    title: r.embedMeta?.title ?? null,
    embedUrl: r.embedUrl,
    status: r.status as MediaItem["status"],
  }));
}
