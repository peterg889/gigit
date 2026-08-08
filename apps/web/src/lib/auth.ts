import {
  AccountUnavailableError,
  db,
  MarketplaceProfileUnavailableError,
  OpenSlotStartTimeError,
  schema,
  TechSubslotAlreadyActiveError,
  TechSubslotParentUnavailableError,
  TechUnavailableError,
  VenuePaymentMethodRequiredError,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { liveProfileForActiveAccount } from "./profile-capabilities";
import { sessionUserId } from "./session";
import { fail } from "./respond";

export class AuthError extends Error {
  /**
   * `code` is part of the wire contract, not decoration: the admin routes have
   * always answered a non-admin with `forbidden`, so it has to survive the trip
   * through respondError rather than collapse into the generic `auth`.
   */
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "auth",
  ) {
    super(message);
  }
}

/**
 * The standard route catch tail: render an AuthError as its HTTP status, and
 * rethrow anything else (a real 500). Routes with richer error mapping check
 * their domain errors first, then fall through to this.
 */
export function respondError(e: unknown): NextResponse {
  if (e instanceof AuthError) return fail(e.code, e.message, e.status);
  if (e instanceof AccountUnavailableError)
    return fail(
      e.code,
      "This account is no longer active. Reload the page and try again.",
      409,
    );
  if (e instanceof MarketplaceProfileUnavailableError)
    return fail(
      e.code,
      "That profile is no longer available. Reload the page and try again.",
      409,
    );
  if (e instanceof TechSubslotParentUnavailableError)
    return fail(
      e.code,
      "This sound job is no longer available because its booking changed or the gig has passed. Reload the page.",
      409,
    );
  if (e instanceof TechSubslotAlreadyActiveError)
    return fail(
      e.code,
      "This booking already has an active sound job. Open it instead of posting another.",
      409,
    );
  if (e instanceof TechUnavailableError)
    return fail(
      e.code,
      "That sound tech is already booked for an overlapping gig. Choose another tech or a different time.",
      409,
    );
  if (e instanceof VenuePaymentMethodRequiredError)
    return fail(
      e.code,
      "Add a payment method first — the booking is charged when the act accepts. Go to Profile → Add a payment method.",
      409,
    );
  if (e instanceof OpenSlotStartTimeError)
    return fail(
      e.code,
      "This date has already passed. Choose a future date and try again.",
      409,
    );
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

/**
 * The ops gate for /api/admin/* — an active session that also holds the admin
 * actor role.
 *
 * Seven routes opened with the same two lines and the same 403 body. A staff
 * check written seven times is a staff check that can be forgotten once, and
 * every one of these routes moves money, suspends accounts, or resolves
 * disputes. Route-side only: it THROWS, which respondError renders as JSON.
 * Server components must use adminUserId() instead — see AdminOnly.
 */
export async function requireAdmin(): Promise<string> {
  const userId = await requireUser();
  if (!(await isAdmin(userId)))
    throw new AuthError(403, "That page is for EightGig staff.", "forbidden");
  return userId;
}

/**
 * The ops gate for the /admin/* PAGES: the admin's id, or null.
 *
 * Deliberately not built on requireUser(). A server component that throws
 * renders the error boundary, so an anonymous visitor following an ops link
 * would get a crash page instead of the sign-in card — and, being a null return
 * rather than a throw, this can never fail open the way a forgotten `await`
 * on a boolean check would.
 */
export async function adminUserId(): Promise<string | null> {
  const userId = await sessionUserId();
  if (!userId) return null;
  return (await isAdmin(userId)) ? userId : null;
}

export async function performerOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.performers)
    .where(eq(schema.performers.ownerUserId, userId))
    .orderBy(...schema.profilePreferenceOrder(schema.performers));
  return rows[0] ?? null;
}

export async function venueOwnedBy(userId: string) {
  const rows = await db()
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.ownerUserId, userId))
    .orderBy(...schema.profilePreferenceOrder(schema.venues));
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
    .orderBy(...schema.profilePreferenceOrder(schema.techs));
  return rows[0] ?? null;
}

/**
 * Load both durable ownership identities and the profiles that can advertise a
 * new marketplace action right now.
 *
 * `owned` intentionally keeps suspended/hidden fallbacks for booking history.
 * `live` is the UI capability boundary: an active account plus a live profile.
 * API routes still enforce the authoritative transactional boundary.
 */
export async function profileCapabilitiesOwnedBy(userId: string) {
  const [[account], performer, venue, tech] = await Promise.all([
    db()
      .select({ status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1),
    performerOwnedBy(userId),
    venueOwnedBy(userId),
    techOwnedBy(userId),
  ]);
  const accountStatus = account?.status ?? null;
  return {
    accountStatus,
    owned: { performer, venue, tech },
    live: {
      performer: liveProfileForActiveAccount(accountStatus, performer),
      venue: liveProfileForActiveAccount(accountStatus, venue),
      tech: liveProfileForActiveAccount(accountStatus, tech),
    },
  };
}

/**
 * Which side of the booking funds this sound sub-slot.
 *
 * It is an AUTHORIZATION predicate, so every copy of it means adding a payer
 * case or an admin override is another edit, and missing one lets the wrong
 * party book, cancel, or review someone else's sound job.
 *
 * Takes OWNED profiles, never the `live` ones: a suspended venue is still the
 * payer of a sound job it already funded, and must keep seeing the applicants
 * on its own booking. Whether it may still ACT is a separate question the
 * routes answer transactionally.
 */
export function isSubslotPayer(
  subslot: { payer: string },
  booking: { venueId: string; performerId: string },
  owned: {
    performer: { id: string } | null | undefined;
    venue: { id: string } | null | undefined;
  },
): boolean {
  return subslot.payer === "venue"
    ? owned.venue?.id === booking.venueId
    : owned.performer?.id === booking.performerId;
}

/**
 * Load a sound job with the caller's relationship to it already worked out.
 *
 * The load itself — an identical join plus the same 3× profile lookup — was
 * written out four times, each re-deriving the payer predicate on the spot.
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
  const isPayer = isSubslotPayer(row.subslot, row.booking, { performer, venue });
  return {
    ...row,
    performer,
    venue,
    tech,
    isPayer,
    isBookedTech: !!tech && row.subslot.techId === tech.id,
  };
}

/**
 * Load a booking with the caller's relationship to it already worked out.
 *
 * The load itself (booking row + both profile lookups) was byte-identical in
 * three routes, each then reading the same relationship differently: cancel needs
 * to know which SIDE you are to pick the event, dispute the same, tech-subslot
 * only whether you're a party at all. Sharing the derivation means a new party
 * type or an admin override is one edit, and the notion of "party to this
 * booking" can't drift between the three places that decide it.
 */
export async function loadBookingForActor(bookingId: string, userId: string) {
  const [booking] = await db()
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.id, bookingId));
  if (!booking) return null;
  const [performer, venue] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
  ]);
  const asVenue = !!venue && venue.id === booking.venueId;
  const asPerformer = !!performer && performer.id === booking.performerId;
  return {
    booking,
    performer,
    venue,
    asVenue,
    asPerformer,
    isParty: asVenue || asPerformer,
  };
}
