import { db, schema } from "@gigit/db";
import { inArray } from "drizzle-orm";
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
        ...schema.profilePreferenceOrder(schema.performers),
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
        ...schema.profilePreferenceOrder(schema.venues),
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
        ...schema.profilePreferenceOrder(schema.techs),
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
