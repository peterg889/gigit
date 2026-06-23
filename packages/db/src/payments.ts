/**
 * Payment gateway (engineering-spec K3): Stripe Connect Express, destination
 * charges held in platform balance, transfers on release. The Null gateway
 * auto-succeeds so the full state machine runs with no money moving — this is
 * the DISCOVERY-FIRST launch default (PAYMENTS_ENABLED unset/false; the venue
 * pays the act directly — see docs/pricing.md), as well as dev. The real
 * Stripe gateway activates only when PAYMENTS_ENABLED=true and keys are set.
 *
 * The gateway is called by the WORKER (charge/transfer/refund execution) and
 * by the WEB webhook route (signature verification). State transitions remain
 * the transition runner's job — the gateway never mutates bookings directly.
 */
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { env } from "./env.js";
import { bookings, performers, venues } from "./schema.js";

export interface ChargeResult {
  status: "succeeded" | "pending" | "failed";
  paymentRef: string;
}

export interface PaymentGateway {
  readonly name: "null" | "stripe";
  /** Charge the venue for a booking. Pending = webhook will deliver the outcome. */
  charge(bookingId: string): Promise<ChargeResult>;
  /** Transfer released funds to the performer's connected account. */
  transfer(bookingId: string, amountCents: number): Promise<void>;
  /** Refund (part of) the original charge to the venue. */
  refund(bookingId: string, amountCents: number): Promise<void>;
  /** Create/refresh a Connect Express onboarding link for a performer. */
  connectOnboardingLink(performerId: string, returnUrl: string): Promise<string | null>;
  /** Can this performer receive money? Gates offer acceptance (spec §6). */
  performerPayoutReady(performerId: string): Promise<boolean>;
  /** Hosted setup-mode Checkout to save a venue payment method. */
  paymentSetupLink(venueId: string, returnUrl: string): Promise<string | null>;
  /** Does the venue have a chargeable payment method? Gates sending offers. */
  venuePaymentReady(venueId: string): Promise<boolean>;
  /** Persist the payment method captured by a completed setup session. */
  completeSetupSession(setupIntentId: string, venueId: string): Promise<void>;
}

class NullGateway implements PaymentGateway {
  readonly name = "null" as const;
  async charge(bookingId: string): Promise<ChargeResult> {
    const ref = `null_pi_${bookingId}`;
    await db()
      .update(bookings)
      .set({ paymentRef: ref })
      .where(eq(bookings.id, bookingId));
    return { status: "succeeded", paymentRef: ref };
  }
  async transfer(): Promise<void> {}
  async refund(): Promise<void> {}
  async connectOnboardingLink(): Promise<string | null> {
    return null;
  }
  async performerPayoutReady(): Promise<boolean> {
    return true; // dev: no money moves, nothing to gate
  }
  async paymentSetupLink(): Promise<string | null> {
    return null;
  }
  async venuePaymentReady(): Promise<boolean> {
    return true;
  }
  async completeSetupSession(): Promise<void> {}
}

class StripeGateway implements PaymentGateway {
  readonly name = "stripe" as const;
  private stripe: Stripe;
  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async charge(bookingId: string): Promise<ChargeResult> {
    const d = db();
    const [row] = await d
      .select({ booking: bookings, venue: venues })
      .from(bookings)
      .innerJoin(venues, eq(bookings.venueId, venues.id))
      .where(eq(bookings.id, bookingId));
    if (!row) throw new Error(`booking ${bookingId} not found`);
    if (!row.venue.stripeCustomerId || !row.venue.defaultPaymentMethodId)
      return { status: "failed", paymentRef: "no_payment_method" };

    const pi = await this.stripe.paymentIntents.create(
      {
        amount: row.booking.terms.amountCents,
        currency: "usd",
        customer: row.venue.stripeCustomerId,
        payment_method: row.venue.defaultPaymentMethodId,
        off_session: true,
        confirm: true,
        transfer_group: bookingId,
        metadata: { bookingId },
      },
      { idempotencyKey: `charge:${bookingId}` },
    );
    await d
      .update(bookings)
      .set({ paymentRef: pi.id })
      .where(eq(bookings.id, bookingId));
    // Outcome arrives via webhook (payment_intent.succeeded / .payment_failed);
    // synchronous success is reported as pending and confirmed by the webhook
    // so there is exactly one path into the state machine.
    return { status: "pending", paymentRef: pi.id };
  }

  async transfer(bookingId: string, amountCents: number): Promise<void> {
    const d = db();
    const [row] = await d
      .select({ booking: bookings, performer: performers })
      .from(bookings)
      .innerJoin(performers, eq(bookings.performerId, performers.id))
      .where(eq(bookings.id, bookingId));
    if (!row?.performer.stripeAccountId)
      throw new Error(`performer for ${bookingId} has no connected account`);
    await this.stripe.transfers.create(
      {
        amount: amountCents,
        currency: "usd",
        destination: row.performer.stripeAccountId,
        transfer_group: bookingId,
        metadata: { bookingId },
      },
      { idempotencyKey: `transfer:${bookingId}:${amountCents}` },
    );
  }

  async refund(bookingId: string, amountCents: number): Promise<void> {
    const [row] = await db()
      .select({ paymentRef: bookings.paymentRef })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    if (!row?.paymentRef) throw new Error(`booking ${bookingId} has no charge`);
    await this.stripe.refunds.create(
      { payment_intent: row.paymentRef, amount: amountCents },
      { idempotencyKey: `refund:${bookingId}:${amountCents}` },
    );
  }

  async connectOnboardingLink(
    performerId: string,
    returnUrl: string,
  ): Promise<string | null> {
    const d = db();
    const [p] = await d
      .select()
      .from(performers)
      .where(eq(performers.id, performerId));
    if (!p) return null;
    let accountId = p.stripeAccountId;
    if (!accountId) {
      const account = await this.stripe.accounts.create({
        type: "express",
        metadata: { performerId },
      });
      accountId = account.id;
      await d
        .update(performers)
        .set({ stripeAccountId: accountId })
        .where(eq(performers.id, performerId));
    }
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: returnUrl,
      return_url: returnUrl,
    });
    return link.url;
  }

  async performerPayoutReady(performerId: string): Promise<boolean> {
    const [p] = await db()
      .select({ stripeAccountId: performers.stripeAccountId })
      .from(performers)
      .where(eq(performers.id, performerId));
    if (!p?.stripeAccountId) return false;
    const account = await this.stripe.accounts.retrieve(p.stripeAccountId);
    return account.payouts_enabled === true;
  }

  async paymentSetupLink(venueId: string, returnUrl: string): Promise<string | null> {
    const d = db();
    const [v] = await d.select().from(venues).where(eq(venues.id, venueId));
    if (!v) return null;
    let customerId = v.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        name: v.name,
        metadata: { venueId },
      });
      customerId = customer.id;
      await d
        .update(venues)
        .set({ stripeCustomerId: customerId })
        .where(eq(venues.id, venueId));
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: returnUrl,
      cancel_url: returnUrl,
      metadata: { venueId },
    });
    return session.url;
  }

  async venuePaymentReady(venueId: string): Promise<boolean> {
    const [v] = await db()
      .select({ defaultPaymentMethodId: venues.defaultPaymentMethodId })
      .from(venues)
      .where(eq(venues.id, venueId));
    return !!v?.defaultPaymentMethodId;
  }

  async completeSetupSession(setupIntentId: string, venueId: string): Promise<void> {
    const si = await this.stripe.setupIntents.retrieve(setupIntentId);
    const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
    if (!pm) throw new Error(`setup intent ${setupIntentId} has no payment method`);
    await db()
      .update(venues)
      .set({ defaultPaymentMethodId: pm })
      .where(eq(venues.id, venueId));
  }
}

/**
 * Whether the gig-payments rail is live. Discovery-first launch: false (the
 * venue pays the act directly; NullGateway, no money moves — docs/pricing.md).
 * Requires BOTH the explicit PAYMENTS_ENABLED switch and a Stripe key, so the
 * rail is never turned on by accident. The web UI reads this to decide whether
 * to surface payout/payment-method prompts at all.
 */
export function paymentsEnabled(): boolean {
  return env().PAYMENTS_ENABLED && !!env().STRIPE_SECRET_KEY;
}

let gateway: PaymentGateway | undefined;

export function paymentGateway(): PaymentGateway {
  if (!gateway) {
    const key = env().STRIPE_SECRET_KEY;
    gateway = env().PAYMENTS_ENABLED && key ? new StripeGateway(key) : new NullGateway();
  }
  return gateway;
}

/** Test seam: drop the memoized gateway so a later env change re-selects it. */
export function resetGateway(): void {
  gateway = undefined;
}

/** Webhook signature verification (web route uses this). */
export function constructStripeEvent(
  payload: string | Buffer,
  signature: string,
): Stripe.Event {
  const key = env().STRIPE_SECRET_KEY;
  const whSecret = env().STRIPE_WEBHOOK_SECRET;
  if (!key || !whSecret) throw new Error("stripe is not configured");
  return new Stripe(key).webhooks.constructEvent(payload, signature, whSecret);
}
