import { newId } from "@gigit/domain";
import { db } from "../client.js";
import * as schema from "../schema.js";

/**
 * Test fixtures for the shapes every suite needs.
 *
 * Written because all ~30 hand-rolled venue inserts omitted `timeZone`, so every
 * venue in the suite defaulted to UTC — and `venueLocationIsComplete` treats UTC
 * as the legacy-migration fallback rather than a real answer, returning false. The
 * consequence was that the entire venue-local scheduling path was unreachable
 * from a test: anyone writing one got a 409 and "fixed" the assertion instead of
 * the fixture. A default that makes the realistic path work is the fix.
 *
 * Defaults describe a complete, bookable Milwaukee room. Override anything.
 */

/** Chicago, so DST actually applies — the whole point of not defaulting to UTC. */
export const TEST_TIME_ZONE = "America/Chicago";
export const TEST_METRO = "milwaukee";

export interface VenueOverrides {
  id?: string;
  ownerUserId?: string;
  kind?: string;
  name?: string;
  metro?: string;
  addressLine1?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  timeZone?: string;
  lat?: number;
  lng?: number;
  capacity?: number;
  paInventory?: typeof schema.venues.$inferInsert.paInventory;
  status?: string;
}

/** A user row, since every profile needs an owner. */
export async function makeUser(overrides: { id?: string; email?: string } = {}) {
  const id = overrides.id ?? newId("user");
  await db()
    .insert(schema.users)
    .values({ id, email: overrides.email ?? `${id}@t.test` });
  return id;
}

/**
 * A complete, bookable venue. Creates its own owner unless you pass one —
 * `venues_owner_uq` allows one live venue per user, so sharing an owner across
 * two venues is a constraint violation, not a shortcut.
 */
export async function makeVenue(overrides: VenueOverrides = {}) {
  const ownerUserId = overrides.ownerUserId ?? (await makeUser());
  const id = overrides.id ?? newId("venue");
  await db()
    .insert(schema.venues)
    .values({
      id,
      ownerUserId,
      kind: overrides.kind ?? "bar",
      name: overrides.name ?? "Test Room",
      metro: overrides.metro ?? TEST_METRO,
      addressLine1: overrides.addressLine1 ?? "1 Test St",
      city: overrides.city ?? "Milwaukee",
      region: overrides.region ?? "WI",
      postalCode: overrides.postalCode ?? "53202",
      timeZone: overrides.timeZone ?? TEST_TIME_ZONE,
      lat: overrides.lat ?? 43.0389,
      lng: overrides.lng ?? -87.9065,
      capacity: overrides.capacity ?? 120,
      // hasOperator stated, because omitting it means "nobody has said" and
      // yields the `unknown` sound verdict rather than a definite one.
      paInventory:
        overrides.paInventory ?? {
          hasPA: true,
          mixerChannels: 8,
          micsAvailable: 2,
          monitors: 1,
          hasOperator: false,
        },
      ...(overrides.status ? { status: overrides.status } : {}),
    });
  return { id, ownerUserId };
}

export interface PerformerOverrides {
  id?: string;
  ownerUserId?: string;
  kind?: string;
  name?: string;
  homeMetro?: string;
  bio?: string;
  techNeeds?: typeof schema.performers.$inferInsert.techNeeds;
  status?: string;
}

/** An act with a stated input count, so the sound plan can reach a verdict. */
export async function makePerformer(overrides: PerformerOverrides = {}) {
  const ownerUserId = overrides.ownerUserId ?? (await makeUser());
  const id = overrides.id ?? newId("performer");
  await db()
    .insert(schema.performers)
    .values({
      id,
      ownerUserId,
      kind: overrides.kind ?? "band",
      name: overrides.name ?? "Test Band",
      homeMetro: overrides.homeMetro ?? TEST_METRO,
      // Whether an act has written a bio is behaviour now, not decoration: the
      // public profile prompts the owner for one and stays silent to a visitor.
      ...(overrides.bio !== undefined ? { bio: overrides.bio } : {}),
      techNeeds: overrides.techNeeds ?? { inputs: 4, micsNeeded: 2 },
      ...(overrides.status ? { status: overrides.status } : {}),
    });
  return { id, ownerUserId };
}
