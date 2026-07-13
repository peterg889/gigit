import { db, env, schema } from "@gigit/db";
import { jwtVerify, SignJWT } from "jose";
import { eq, or } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

const key = () => new TextEncoder().encode(env().SESSION_SECRET);

/** GET /api/calendar?token=… → iCal feed of confirmed bookings (F3.6).
 *  POST /api/calendar → signed feed URL for the current user (revocable by secret rotation). */
export async function POST() {
  try {
    const userId = await requireUser();
    const token = await new SignJWT({ sub: userId, scope: "ical" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("365d")
      .sign(key());
    return ok({ url: `${env().APP_URL}/api/calendar?token=${token}` });
  } catch (e) {
    return respondError(e);
  }
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return fail("auth", "token required", 401);
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.scope !== "ical" || typeof payload.sub !== "string")
      throw new Error("bad scope");
    userId = payload.sub;
  } catch {
    return fail("auth", "invalid token", 401);
  }

  const d = db();
  const [performer, venue] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
  ]);
  const conditions = [];
  if (performer) conditions.push(eq(schema.bookings.performerId, performer.id));
  if (venue) conditions.push(eq(schema.bookings.venueId, venue.id));
  const rows = conditions.length
    ? await d
        .select({
          booking: schema.bookings,
          venueName: schema.venues.name,
          venueAddressLine1: schema.venues.addressLine1,
          venueAddressLine2: schema.venues.addressLine2,
          venueCity: schema.venues.city,
          venueRegion: schema.venues.region,
          venuePostalCode: schema.venues.postalCode,
          performerName: schema.performers.name,
        })
        .from(schema.bookings)
        .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
        .innerJoin(
          schema.performers,
          eq(schema.bookings.performerId, schema.performers.id),
        )
        .where(or(...conditions))
    : [];

  const fmt = (iso: string) =>
    iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const events = rows
    .filter((r) => ["confirmed", "awaiting_confirmation"].includes(r.booking.state))
    .map((r) =>
      [
        "BEGIN:VEVENT",
        `UID:${r.booking.id}@gigit`,
        `DTSTART:${fmt(r.booking.terms.startsAt)}`,
        `DTEND:${fmt(r.booking.terms.endsAt)}`,
        `SUMMARY:${icalEscape(`${r.performerName} at ${r.venueName}`)}`,
        `LOCATION:${icalEscape(
          [
            r.venueAddressLine1,
            r.venueAddressLine2,
            r.venueCity,
            r.venueRegion,
            r.venuePostalCode,
          ]
            .filter(Boolean)
            .join(", "),
        )}`,
        `DESCRIPTION:$${(r.booking.terms.amountCents / 100).toFixed(0)} — booked on Gigit`,
        "END:VEVENT",
      ].join("\r\n"),
    );
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Gigit//bookings//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
  return new Response(ics, {
    headers: { "content-type": "text/calendar; charset=utf-8" },
  });
}

function icalEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}
