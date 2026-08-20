import { appendEvent, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import {
  performerOwnedBy,
  requireUser,
  respondError,
  techOwnedBy,
  venueOwnedBy,
} from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * The three profile kinds a media asset can hang on. `subject_type` is a text
 * column with no enum behind it, so a row could in principle carry something
 * else; narrowing here means the ownership switch below is exhaustive rather
 * than falling through to a default that guesses.
 */
const SUBJECT_TYPES = ["performer", "venue", "tech"] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];
const isSubjectType = (v: string): v is SubjectType =>
  (SUBJECT_TYPES as readonly string[]).includes(v);

/**
 * Remove one media link (engineering-spec §8: media is link-only).
 *
 * EightGig stores no files — every asset is a URL on a host that already serves
 * it — so removing one is a row delete and nothing else. There is no object to
 * expire, no bucket to reconcile, and no window in which the row is gone but
 * the bytes are still fetchable.
 *
 * Deleting is allowed from EVERY status, `held` and `blocked` included. Those
 * are precisely the states an owner most needs out of the way: a link the screen
 * held or a moderator refused is invisible on the public page but still consumes
 * the per-kind quota, so refusing to delete it would burn one of five video slots
 * permanently on something the site will never show. It is also the main case
 * this route exists for — someone pasted the wrong link and wants it gone.
 */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();

    const d = db();
    const [asset] = await d
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, id));
    if (!asset) return fail("not_found", "We couldn't find that link.", 404);

    // Ownership is the whole authorization story, and it is resolved exactly the
    // way POST /api/media/embed resolves it: the caller's own profile OF THE
    // ASSET'S TYPE, then that profile must be the one the asset hangs on.
    //
    // Deliberately not `asset.ownerUserId === userId`. The two agree today, but
    // they answer different questions: ownerUserId records who pasted the link,
    // while the profile match is what "this is on my page" means — and it is the
    // profile lookups, not the paster, that carry profilePreferenceOrder's rule
    // about which of an owner's rows represents them.
    const owner = !isSubjectType(asset.subjectType)
      ? null
      : asset.subjectType === "performer"
        ? await performerOwnedBy(userId)
        : asset.subjectType === "venue"
          ? await venueOwnedBy(userId)
          : await techOwnedBy(userId);
    if (!owner || owner.id !== asset.subjectId)
      return fail("forbidden", "That link isn't on a profile you own.", 403);

    const closed = await d.transaction(async (tx) => {
      const removed = await tx
        .delete(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, id))
        .returning({ id: schema.mediaAssets.id });
      // Lost a race with another tab of the same owner. Falling through would
      // append a second media.deleted event for a delete that removed nothing.
      if (removed.length === 0) return null;

      // fraud_flags points at media by the (subject_type, subject_id) pair —
      // polymorphic, so there is no foreign key and the database will not notice
      // the subject going away. An open flag left behind is a card in the ops
      // moderation queue naming an asset no moderator can look at, whose Clear
      // and Uphold buttons both silently no-op on the `if (asset)` guard in
      // flags/[id]/resolve: a decision that appears to have been taken and
      // changed nothing.
      //
      // `moot`, not `cleared` or `upheld`: both of those record that a person
      // looked at the link and decided to publish or refuse it. Nobody decided
      // anything here. The flag and its evidence are kept rather than deleted —
      // it is the screening record for a link that can be pasted again, and the
      // same URL coming back is exactly what a moderator would want the history
      // for.
      const mooted = await tx
        .update(schema.fraudFlags)
        .set({ state: "moot" })
        .where(
          and(
            eq(schema.fraudFlags.subjectType, "media"),
            eq(schema.fraudFlags.subjectId, id),
            eq(schema.fraudFlags.state, "open"),
          ),
        )
        .returning({ id: schema.fraudFlags.id });

      // The event log keeps naming this id after the row is gone, which is what
      // an append-only log is for. Nothing downstream dereferences it: the one
      // media handler in the outbox (media.screen_requested → screenMedia)
      // already returns on a missing asset, so a delete that races an unscreened
      // link's screen is a no-op rather than a crash.
      await appendEvent(tx, {
        actor: userId,
        kind: "media.deleted",
        subjectType: "media",
        subjectId: id,
        payload: {
          subjectType: asset.subjectType,
          subjectId: asset.subjectId,
          kind: asset.kind,
          url: asset.embedUrl,
          statusWhenDeleted: asset.status,
          mootedFlagIds: mooted.map((f) => f.id),
        },
      });
      return { mootedFlags: mooted.length };
    });
    if (!closed) return fail("not_found", "We couldn't find that link.", 404);

    return ok({ deleted: true, id });
  } catch (e) {
    return respondError(e);
  }
}
