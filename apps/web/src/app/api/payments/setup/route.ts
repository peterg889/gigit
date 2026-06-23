import { env, paymentGateway, paymentsEnabled } from "@gigit/db";
import { AuthError, requireUser, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

/**
 * Hosted setup-mode Checkout link for the venue's payment method (F4.1).
 * Required before offers when Stripe is active; deferred at discovery-first launch.
 */
export async function POST() {
  try {
    // Discovery-first: the venue pays the act directly, no card to capture.
    if (!paymentsEnabled())
      return fail("payments_disabled", "Gigit doesn't take payment right now", 404);
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);
    const url = await paymentGateway().paymentSetupLink(
      venue.id,
      `${env().APP_URL}/me`,
    );
    if (!url) return ok({ notConfigured: true });
    return ok({ url });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
