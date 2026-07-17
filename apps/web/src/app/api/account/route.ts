import { deactivateAccount } from "@gigit/db";
import { requireUser, respondError } from "@/lib/auth";
import { ok } from "@/lib/respond";
import { destroySession } from "@/lib/session";

/**
 * Deactivate access and remove login identifiers immediately. Marketplace
 * records remain so completed bookings, reviews, disputes, and audit history
 * do not become misleading when one party leaves — but live commitments are
 * wound down first (offers declined/withdrawn, confirmed gigs cancelled with
 * counterparty notification, open slots and series closed) so nobody is left
 * booked with a ghost.
 */
export async function DELETE() {
  try {
    const userId = await requireUser();
    await deactivateAccount(userId);
    await destroySession();
    return ok({ deactivated: true });
  } catch (e) {
    return respondError(e);
  }
}
