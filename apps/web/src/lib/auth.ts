import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
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

export async function requireUser(): Promise<string> {
  const userId = await sessionUserId();
  if (!userId) throw new AuthError(401, "sign in required");
  // Suspension (F9.1) bites here so every mutation route inherits it.
  const [user] = await db()
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (user?.status === "suspended")
    throw new AuthError(403, "This account is suspended. Contact support.");
  return userId;
}

export async function performerOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.performers)
    .where(eq(schema.performers.ownerUserId, userId));
  return rows[0] ?? null;
}

export async function venueOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.ownerUserId, userId));
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
    .where(eq(schema.techs.ownerUserId, userId));
  return rows[0] ?? null;
}
