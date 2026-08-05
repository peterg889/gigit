import { db, schema } from "@gigit/db";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { participantLabels, type ProfileIdentity } from "./thread-display";

/**
 * Resolve one deterministic profile identity per role for each participant.
 *
 * Legacy owners may retain hidden duplicate profiles after the uniqueness
 * migration repairs their public profile. Prefer live, then the profile an
 * admin temporarily suspended; only when neither exists use the oldest hidden
 * row and its ID as a stable tie-breaker. Multi-role owners still contribute
 * one identity for each role.
 */
export async function loadParticipantLabels(
  participantUserIds: readonly string[],
): Promise<Map<string, string>> {
  const userIds = [...new Set(participantUserIds)];
  if (userIds.length === 0) return new Map();

  const d = db();
  const [performers, venues, techs] = await Promise.all([
    d
      .selectDistinctOn([schema.performers.ownerUserId], {
        userId: schema.performers.ownerUserId,
        name: schema.performers.name,
      })
      .from(schema.performers)
      .where(inArray(schema.performers.ownerUserId, userIds))
      .orderBy(
        schema.performers.ownerUserId,
        desc(eq(schema.performers.status, "live")),
        desc(eq(schema.performers.status, "suspended")),
        asc(schema.performers.createdAt),
        asc(schema.performers.id),
      ),
    d
      .selectDistinctOn([schema.venues.ownerUserId], {
        userId: schema.venues.ownerUserId,
        name: schema.venues.name,
      })
      .from(schema.venues)
      .where(inArray(schema.venues.ownerUserId, userIds))
      .orderBy(
        schema.venues.ownerUserId,
        desc(eq(schema.venues.status, "live")),
        desc(eq(schema.venues.status, "suspended")),
        asc(schema.venues.createdAt),
        asc(schema.venues.id),
      ),
    d
      .selectDistinctOn([schema.techs.ownerUserId], {
        userId: schema.techs.ownerUserId,
        name: schema.techs.name,
      })
      .from(schema.techs)
      .where(inArray(schema.techs.ownerUserId, userIds))
      .orderBy(
        schema.techs.ownerUserId,
        desc(eq(schema.techs.status, "live")),
        desc(eq(schema.techs.status, "suspended")),
        asc(schema.techs.createdAt),
        asc(schema.techs.id),
      ),
  ]);

  const identities: ProfileIdentity[] = [
    ...performers.map((profile) => ({ ...profile, role: "act" as const })),
    ...venues.map((profile) => ({ ...profile, role: "venue" as const })),
    ...techs.map((profile) => ({
      ...profile,
      role: "sound tech" as const,
    })),
  ];
  return participantLabels(identities);
}
