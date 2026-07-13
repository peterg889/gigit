import { AiNotConfiguredError, slotParse } from "@gigit/db";
import { z } from "zod";
import { AuthError, requireUser, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import { venueLocationIsComplete } from "@/lib/date-time";

const bodySchema = z.object({ text: z.string().min(5).max(1000) });

/**
 * Natural-language slot posting (F2.8): free text → slot DRAFT the venue
 * confirms before it is posted. The SMS surface (Twilio inbound) routes
 * through this same function once A2P registration lands.
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue)
      return fail("forbidden", "venue profile required", 403);
    if (!venueLocationIsComplete(venue))
      return fail(
        "venue_location_required",
        "add your venue address and timezone before drafting a slot",
        409,
      );
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const draft = await slotParse(parsed.data.text, userId, new Date(), venue.timeZone);
    return ok({ draft });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    if (e instanceof AiNotConfiguredError)
      return fail("ai_not_configured", e.message, 503);
    return fail("parse_failed", String(e), 502);
  }
}
