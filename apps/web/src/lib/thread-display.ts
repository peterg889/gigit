export interface ProfileIdentity {
  userId: string;
  name: string;
  role: "act" | "venue" | "sound tech";
}

/**
 * Build one useful label per person without silently choosing whichever profile
 * happened to be queried first. Most people have one profile and just see its
 * name; multi-role owners get enough context to distinguish those identities.
 */
export function participantLabels(
  identities: ProfileIdentity[],
): Map<string, string> {
  const byUser = new Map<string, ProfileIdentity[]>();
  for (const identity of identities) {
    const current = byUser.get(identity.userId) ?? [];
    if (
      !current.some(
        (item) => item.name === identity.name && item.role === identity.role,
      )
    ) {
      current.push(identity);
      byUser.set(identity.userId, current);
    }
  }

  const labels = new Map<string, string>();
  for (const [userId, profiles] of byUser) {
    if (profiles.length === 1) {
      labels.set(userId, profiles[0]!.name);
      continue;
    }

    const rolesByName = new Map<string, string[]>();
    for (const profile of profiles) {
      const roles = rolesByName.get(profile.name) ?? [];
      if (!roles.includes(profile.role)) roles.push(profile.role);
      rolesByName.set(profile.name, roles);
    }
    labels.set(
      userId,
      [...rolesByName]
        .map(([name, roles]) => `${name} (${roles.join(" / ")})`)
        .join(" · "),
    );
  }
  return labels;
}

export function counterpartyLabel(
  participantUserIds: string[],
  viewerUserId: string,
  labels: ReadonlyMap<string, string>,
): string | null {
  const names = [
    ...new Set(
      participantUserIds
        .filter((id) => id !== viewerUserId)
        .map((id) => labels.get(id) ?? "Participant"),
    ),
  ];
  return names.length > 0 ? names.join(" & ") : null;
}
