import { db, schema } from "@gigit/db";
import { asc, eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { sessionUserId } from "./session";
import { fail } from "./respond";

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The standard route catch tail: render an AuthError as its HTTP status, and
 * rethrow anything else (a real 500). Routes with richer error mapping check
 * their domain errors first, then fall through to this.
 */
export function respondError(e: unknown): NextResponse {
  if (e instanceof AuthError) return fail("auth", e.message, e.status);
  throw e;
}

/**
 * Suspension and deactivation (F9.1) bite here, so every caller inherits it.
 *
 * Split out from requireUser because not every authenticated surface arrives by
 * session cookie: the iCal feed authenticates a 365-day signed token, and it
 * used to go straight from token to profile lookup — so a suspended or
 * deactivated account kept serving confirmed bookings, with venue street
 * addresses and pay, until SESSION_SECRET was rotated.
 */
export async function assertAccountActive(userId: string): Promise<string> {
  const [user] = await db()
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (user?.status === "suspended")
    throw new AuthError(403, "This account is suspended. Contact support.");
  if (user?.status === "deleted")
    throw new AuthError(403, "This account has been deactivated.");
  if (!user) throw new AuthError(401, "sign in required");
  return userId;
}

export async function requireUser(): Promise<string> {
  const userId = await sessionUserId();
  if (!userId) throw new AuthError(401, "sign in required");
  return assertAccountActive(userId);
}

export async function performerOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.performers)
    .where(eq(schema.performers.ownerUserId, userId))
    // Oldest wins, deterministically. A bare rows[0] with no ordering
    // meant a duplicate (possible before performers_owner_uq) resolved
    // differently per request.
    .orderBy(asc(schema.performers.createdAt));
  return rows[0] ?? null;
}

export async function venueOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.ownerUserId, userId))
    // Oldest wins, deterministically. A bare rows[0] with no ordering
    // meant a duplicate (possible before performers_owner_uq) resolved
    // differently per request.
    .orderBy(asc(schema.venues.createdAt));
  return rows[0] ?? null;
}

/** Ops/admin = a row in actor_roles with kind 'admin' (inserted by ops). */
export async function isAdmin(userId: string): Promise<boolean> {
  const rows = await db()
    .select()
    .from(schema.actorRoles)
    .where(eq(schema.actorRoles.userId, userId));
  return rows.some((r) => r.kind === "admin");
}

export async function techOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.techs)
    .where(eq(schema.techs.ownerUserId, userId))
    // Oldest wins, deterministically. A bare rows[0] with no ordering
    // meant a duplicate (possible before performers_owner_uq) resolved
    // differently per request.
    .orderBy(asc(schema.techs.createdAt));
  return rows[0] ?? null;
}

/**
 * Load a sound job with the caller's relationship to it already worked out.
 *
 * The payer predicate — which side of the booking funds this sub-slot — was
 * written out four times, each behind an identical join and a 3× profile lookup.
 * It is an AUTHORIZATION predicate, so four copies means adding a payer case or
 * an admin override is four edits and missing one lets the wrong party book,
 * cancel, or review someone else's sound job.
 */
export async function loadSubslotForActor(subslotId: string, userId: string) {
  const [row] = await db()
    .select({ subslot: schema.techSubslots, booking: schema.bookings })
    .from(schema.techSubslots)
    .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
    .where(eq(schema.techSubslots.id, subslotId));
  if (!row) return null;
  const [performer, venue, tech] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
    techOwnedBy(userId),
  ]);
  const isPayer =
    row.subslot.payer === "venue"
      ? venue?.id === row.booking.venueId
      : performer?.id === row.booking.performerId;
  return {
    ...row,
    performer,
    venue,
    tech,
    isPayer,
    isBookedTech: !!tech && row.subslot.techId === tech.id,
  };
}
