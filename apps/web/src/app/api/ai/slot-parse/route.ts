import { AiNotConfiguredError, slotParse } from "@gigit/db";
import { z } from "zod";
import { AuthError, requireUser, venueOwnedBy } from "@/lib/auth";
import { aiUnavailable, fail, ok, parseBody } from "@/lib/respond";
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
      return fail("forbidden", "You need a venue profile to do that.", 403);
    if (!venueLocationIsComplete(venue))
      return fail(
        "venue_location_required",
        "Add your venue's address and timezone first — a draft needs to know when and where.",
        409,
      );
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const draft = await slotParse(parsed.data.text, userId, new Date(), venue.timeZone);
    return ok({ draft });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    // Unconfigured and broken look the same to the user, and the answer is the
    // same either way: use the form. Never surface the exception — it names an
    // environment variable.
    if (e instanceof AiNotConfiguredError) return aiUnavailable("draft");
    console.log(JSON.stringify({ kind: "ai.parse_failed", err: String(e) }));
    return aiUnavailable("draft");
  }
}
