import { REVIEWABLE_BOOKING_STATES } from "@gigit/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./client.js";
import { bookings, reviews } from "./schema.js";

export interface ReviewProfileSubject {
  kind: "performer" | "venue";
  id: string;
}

/**
 * Reviews attached to gigs that are eligible for post-gig feedback.
 *
 * Filtering belongs in this shared read path as well as the write endpoint so
 * legacy reviews attached to cancelled, collapsed, refunded, or unresolved
 * bookings cannot leak onto either public profile.
 */
export async function reviewableProfileReviews(
  subject: ReviewProfileSubject,
  limit = 50,
) {
  const subjectCondition =
    subject.kind === "performer"
      ? eq(bookings.performerId, subject.id)
      : eq(bookings.venueId, subject.id);

  const rows = await db()
    .select({ review: reviews })
    .from(reviews)
    .innerJoin(bookings, eq(reviews.bookingId, bookings.id))
    .where(
      and(
        subjectCondition,
        inArray(bookings.state, [...REVIEWABLE_BOOKING_STATES]),
      ),
    )
    .orderBy(desc(reviews.createdAt))
    .limit(limit);

  return rows.map(({ review }) => review);
}
