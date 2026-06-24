import { env, paymentGateway, paymentsEnabled } from "@gigit/db";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

/**
 * Stripe Connect Express onboarding link for the performer (K3). Called
 * before first offer acceptance; deferred at the discovery-first launch.
 */
export async function POST() {
  try {
    // Discovery-first: no gig money, no payouts to onboard (docs/pricing.md).
    if (!paymentsEnabled())
      return fail("payments_disabled", "payouts aren't part of Gigit right now", 404);
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "performer profile required", 403);
    const url = await paymentGateway().connectOnboardingLink(
      performer.id,
      `${env().APP_URL}/me`,
    );
    if (!url) return ok({ notConfigured: true });
    return ok({ url });
  } catch (e) {
    return respondError(e);
  }
}
