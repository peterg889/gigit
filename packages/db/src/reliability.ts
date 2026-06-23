/**
 * Reliability stats for a set of performers (PRD F7.3): gigs completed
 * (released bookings) and cancellations (the strike counter, one per performer
 * cancel). Batched so an applicant list or search resolves every act in one
 * query. The pure badge derived from these lives in @gigit/domain
 * (performerReliability) — this module only fetches the two facts.
 */
import { getPool } from "./client.js";

export interface PerformerReliabilityStats {
  gigsCompleted: number;
  cancellations: number;
}

export async function performerReliabilityStats(
  performerIds: string[],
): Promise<Map<string, PerformerReliabilityStats>> {
  const out = new Map<string, PerformerReliabilityStats>();
  if (performerIds.length === 0) return out;
  const { rows } = await getPool().query(
    `select p.id,
            p.reliability_strikes::int as cancellations,
            count(b.id) filter (
              where b.state in ('released','partially_released')
            )::int as gigs_completed
       from performers p
       left join bookings b on b.performer_id = p.id
      where p.id = any($1::text[])
      group by p.id, p.reliability_strikes`,
    [performerIds],
  );
  for (const r of rows)
    out.set(r.id, {
      gigsCompleted: r.gigs_completed,
      cancellations: r.cancellations,
    });
  return out;
}
