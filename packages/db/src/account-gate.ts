import { asc, inArray } from "drizzle-orm";
import type { Tx } from "./client.js";
import { performers, techs, users, venues } from "./schema.js";

export class AccountUnavailableError extends Error {
  readonly code = "account_unavailable";
  constructor(
    readonly userId: string,
    readonly status: string | "missing",
  ) {
    super(`account ${userId} is not active`);
  }
}

export type MarketplaceProfileRole = "performer" | "venue" | "tech";
export class MarketplaceProfileUnavailableError extends Error {
  readonly code = "profile_unavailable";
  constructor(
    readonly role: MarketplaceProfileRole,
    readonly profileId: string,
  ) {
    super(`${role} ${profileId} is not live`);
  }
}

/**
 * Serialize new marketplace work with suspension/deactivation.
 *
 * Every creator takes these user-row locks BEFORE resource locks. Account
 * deactivation takes the same row first and holds it through its complete
 * sweep. Work committed before that gate is visible to the sweep; work that
 * arrives afterward waits, re-reads `deleted`/`suspended`, and rejects.
 */
export async function lockActiveAccounts(
  tx: Tx,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    .for("update");
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of ids) {
    const status = byId.get(id);
    if (status !== "active")
      throw new AccountUnavailableError(id, status ?? "missing");
  }
}

export interface ActiveProfileRefs {
  performerIds?: readonly string[];
  venueIds?: readonly string[];
  techIds?: readonly string[];
  /** Authenticated actors that own no referenced profile (e.g. profile create). */
  additionalUserIds?: readonly string[];
}

/** Lock active owners first, then lock/recheck their public profiles. */
export async function lockActiveProfileOwners(tx: Tx, refs: ActiveProfileRefs) {
  const performerIds = [...new Set(refs.performerIds ?? [])].sort();
  const venueIds = [...new Set(refs.venueIds ?? [])].sort();
  const techIds = [...new Set(refs.techIds ?? [])].sort();

  // First reads discover immutable owner IDs without taking profile locks. The
  // authoritative reads happen again after the sorted user-row gate, avoiding
  // profile→user vs user→profile deadlocks with account status changes.
  // A transaction owns one database connection. Keep its reads sequential;
  // node-postgres is removing concurrent `client.query()` support in pg 9.
  const performerOwners = performerIds.length
    ? await tx
        .select({ id: performers.id, ownerUserId: performers.ownerUserId })
        .from(performers)
        .where(inArray(performers.id, performerIds))
    : [];
  const venueOwners = venueIds.length
    ? await tx
        .select({ id: venues.id, ownerUserId: venues.ownerUserId })
        .from(venues)
        .where(inArray(venues.id, venueIds))
    : [];
  const techOwners = techIds.length
    ? await tx
        .select({ id: techs.id, ownerUserId: techs.ownerUserId })
        .from(techs)
        .where(inArray(techs.id, techIds))
    : [];
  const requireEvery = (
    role: MarketplaceProfileRole,
    requested: readonly string[],
    found: readonly { id: string }[],
  ) => {
    const present = new Set(found.map((row) => row.id));
    const missing = requested.find((id) => !present.has(id));
    if (missing) throw new MarketplaceProfileUnavailableError(role, missing);
  };
  requireEvery("performer", performerIds, performerOwners);
  requireEvery("venue", venueIds, venueOwners);
  requireEvery("tech", techIds, techOwners);

  await lockActiveAccounts(tx, [
    ...performerOwners.map((row) => row.ownerUserId),
    ...venueOwners.map((row) => row.ownerUserId),
    ...techOwners.map((row) => row.ownerUserId),
    ...(refs.additionalUserIds ?? []),
  ]);

  const performerRows = performerIds.length
    ? await tx
        .select()
        .from(performers)
        .where(inArray(performers.id, performerIds))
        .orderBy(asc(performers.id))
        .for("update")
    : [];
  const venueRows = venueIds.length
    ? await tx
        .select()
        .from(venues)
        .where(inArray(venues.id, venueIds))
        .orderBy(asc(venues.id))
        .for("update")
    : [];
  const techRows = techIds.length
    ? await tx
        .select()
        .from(techs)
        .where(inArray(techs.id, techIds))
        .orderBy(asc(techs.id))
        .for("update")
    : [];
  for (const id of performerIds)
    if (performerRows.find((row) => row.id === id)?.status !== "live")
      throw new MarketplaceProfileUnavailableError("performer", id);
  for (const id of venueIds)
    if (venueRows.find((row) => row.id === id)?.status !== "live")
      throw new MarketplaceProfileUnavailableError("venue", id);
  for (const id of techIds)
    if (techRows.find((row) => row.id === id)?.status !== "live")
      throw new MarketplaceProfileUnavailableError("tech", id);

  return {
    performers: new Map(performerRows.map((row) => [row.id, row])),
    venues: new Map(venueRows.map((row) => [row.id, row])),
    techs: new Map(techRows.map((row) => [row.id, row])),
  };
}
