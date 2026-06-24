import { performerOwnedBy, requireUser, respondError, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

export async function GET() {
  try {
    const userId = await requireUser();
    const [performer, venue, tech] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
      techOwnedBy(userId),
    ]);
    return ok({ userId, performer, venue, tech });
  } catch (e) {
    return respondError(e);
  }
}
