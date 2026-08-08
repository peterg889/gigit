export interface RatedReview {
  ratings: Record<string, number>;
}

/**
 * The star average shown on a profile, or `null` when there is nothing to
 * average.
 *
 * `null` rather than 0 is the whole point: every caller renders the badge only
 * when this is non-null, and a 0 is a real-looking rating — a brand-new act
 * with no visible reviews yet would wear "★ 0.0 (0)", which reads as "everyone
 * who worked with them hated it" rather than "no one has said yet".
 *
 * `overall` is read out of a free-form ratings map, so a legacy row missing the
 * key contributes 0 rather than NaN-ing the whole average.
 */
export function averageOverall(reviews: readonly RatedReview[]): number | null {
  if (reviews.length === 0) return null;
  return (
    reviews.reduce((sum, review) => sum + (review.ratings.overall ?? 0), 0) /
    reviews.length
  );
}
