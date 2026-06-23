/**
 * Performer reliability badge (PRD F7.3). With payments deferred, reviews and
 * reliability ARE the trust layer — there's no escrow standing behind a deal,
 * so "does this act show up?" is what a venue is buying. Pure and deterministic
 * from two facts we already track: gigs completed (released bookings) and
 * cancellations (the reliability-strike counter, one per performer cancel).
 *
 * On-brand: the label says the numbers out loud (docs/brand.md §5) rather than
 * inventing a precise-looking score. The tier just drives emphasis + ranking.
 */
export interface ReliabilityStats {
  gigsCompleted: number;
  cancellations: number;
}

export type ReliabilityTier = "new" | "reliable" | "mixed";

export interface Reliability {
  tier: ReliabilityTier;
  /** Human, factual, numbers-out-loud. */
  label: string;
  /** Higher = more reliable. For optional feed/applicant ranking. */
  score: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function performerReliability(stats: ReliabilityStats): Reliability {
  const gigsCompleted = Math.max(0, Math.trunc(stats.gigsCompleted));
  const cancellations = Math.max(0, Math.trunc(stats.cancellations));
  // A cancellation costs far more trust than a gig earns it.
  const score = gigsCompleted - cancellations * 5;

  if (gigsCompleted === 0 && cancellations === 0) {
    return { tier: "new", label: "New to Gigit — no gigs yet", score };
  }

  const played = `${plural(gigsCompleted, "gig")} played`;
  const cancels =
    cancellations === 0
      ? "no cancellations"
      : plural(cancellations, "cancellation");
  const tier: ReliabilityTier = cancellations === 0 ? "reliable" : "mixed";
  return { tier, label: `${played} · ${cancels}`, score };
}
