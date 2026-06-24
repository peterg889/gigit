# Gigit — Pricing & the Discovery-First Posture

**Date:** June 2026. Canonical source for how Gigit charges and what it deliberately defers. Companion to [`PRD.md`](../PRD.md) §4 (business model), [`brand.md`](brand.md), and [`engineering-spec.md`](engineering-spec.md). If this doc and another disagree on money, this doc wins until updated.

---

## 1. The one-paragraph version

There should be more live music in the world. Gigit exists to make more of it happen, not to take a cut of it. So Gigit launches as a **discovery and coordination** platform — it helps venues and acts find each other and shake hands — and **does not touch the gig money**. The venue pays the act directly, the way they already do. Gigit charges the venue a token fee (~$5/month, optional ~$5/booking), and only after the platform is provably filling their calendar. Performers and sound techs never pay anything, ever. The heavier machinery — processing payments, escrow, payouts, contracts, tax — is designed and seam-ready, but switched off until the scene needs it.

## 2. The price list

| Side | Pays | When it turns on |
|---|---|---|
| **Performers** (bands, comedians) | **$0 — forever** | never |
| **Sound techs** | **$0 — forever** | never |
| **Venues** | **~$5 / month** + optional **~$5 / booking** | only after the momentum triggers (§4) fire in their metro; grandfathered free for 12 months if they joined earlier |

- **The gig fee itself is not ours.** $400 for the band is $400 to the band, paid venue→act off-platform. Gigit's fee is separate, small, and the venue's alone.
- **Why the venue, not the act:** the venue is the side that profits from a filled room; the act is the side we're trying to get *more* money to. Charging the act, even a success fee, works against the mission and against the trust that makes a supply-side marketplace valuable (research §7, §11 — Sonicbids).
- **The $5/booking is optional.** The flat $5/month is the spine. The per-booking fee is a usage lever for high-volume venues; we can ship without it and add it later. Decide at momentum, not now.

## 3. Why discovery-first (and not the payments moat)

The competitive research is explicit that "the workflow is the business" and that **disintermediation is the central risk** of a recurring-local-services marketplace. We are knowingly choosing the lighter path anyway, because for *this* team and *this* moment the trade is right:

**What we give up:** lower per-booking capture, and higher leakage — a venue and act who meet on Gigit can next month just text each other. For a pure discovery platform this is real and larger than it would be for a payments platform.

**What we get:**
- **Radically lower cost and complexity.** Roughly half the original architecture exists only to move money (Stripe Connect, the intent ledger, the payment half of the booking state machine, reconciliation, 1099-K). Deferring it removes the biggest build, the biggest ops burden, and the biggest legal surface (money transmission, escrow, worker-classification-via-payment, tax).
- **Faster liquidity.** The only hard thing is getting both sides into the same room. Every dollar of friction removed — including the friction of "set up payouts before you can get booked" — helps the one metric that matters.
- **Mission alignment.** "Cheap as possible, for as long as possible" is only credible if the cost base is genuinely small. Discovery-first makes it small.

**Why the leakage is survivable here:**
- The fee is $5. It isn't worth the hassle of evading.
- The thing that keeps both sides coming back isn't the handshake we already brokered — it's the **feed**: the *next* open slot, the *next* new act, reviews, reliability, the recurring-series tooling. Discovery is a repeat need, not a one-time one.
- We are explicitly trading capture for reach. That is the mission, stated as a business decision.

## 4. The deferral is a seam, not a deletion

The payments architecture stays in the codebase, dormant, behind the gateway seam that already exists (`paymentGateway()` / `NullGateway`). The day a venue says "I wish I could just pay the band through the app," we flip configuration, not architecture.

**Switched OFF for discovery-first (deferred until needed):**

| Area | What goes dormant |
|---|---|
| Stripe Connect | Express onboarding, KYC, payouts, `stripeAccountId`, SetupIntent/Elements card capture |
| Booking state machine | the money path: `request_payment`, `release_funds`, `refund_funds`, `cancellation_fee` effects; the `confirming → confirmed` PaymentIntent step; the `awaiting_confirmation → released` fund-release flow |
| Reconciliation | the nightly ledger-vs-Stripe diff (`reconcileMoney`) — there's nothing external to reconcile against |
| Tax / compliance | W-9/TIN collection, 1099-K issuance, state-threshold config |
| Disputes | the *money-resolution* engine (`release_full`/`refund_full`/`partial`); a lightweight report/flag for reviews + reliability stays |
| Cancellations | external money movement only — `decide()` still *computes* the fee and ledgers the intent, but `NullGateway` moves none of it; cancellations reopen the slot, notify, and apply a reliability strike |

> **The live/dormant boundary.** The pure domain reducer and the intent **ledger stay live**: `decide()` still computes cancellation fees and emits the money *effects*, and `recordLedgerEntry` still records charge/release/fee rows at real contract value (a harmless, useful internal record — and the admin dashboard labels it "Booked value", not "Charged", while payments are off). What's switched off is everything that moves money *out of the platform*: `NullGateway` no-ops every Stripe charge / transfer / refund / payout, so no money actually moves. "Dormant" above means "drives no external money," not "the code never runs."

**Stays ON (this is the product now):**
profiles + link-in onboarding · slot posting (incl. SMS/NL parse) · the gig feed, filters, saved searches · apply / offer / accept handshake · in-app messaging + inquiries · reviews + reliability scores · the **sound-plan engine** · tech sub-slots · recurring series · admin/ops · the `events` outbox + analytics.

**The simplified booking machine.** With money removed, the lifecycle collapses to a handshake:

```
slot open → application → offer → confirmed → played | no_show
```

`confirmed` (the mutual accept) is the terminal commercial state and the billable event when venue pricing is on. No payment states, no fund release. Cancellations branch off with a reliability strike and a reopened slot — no fee schedule. The existing `decide()` reducer already separates effects, so this is mostly *removing* money effects, not rewriting the machine.

## 5. Billing mechanics (when venue pricing turns on)

We keep one thin slice of Stripe — **Stripe Billing**, not Stripe Connect. The difference is the whole point: Connect (onboarding, KYC, escrow, payouts, 1099) is the heavy machinery we deferred; charging a saved card $5 for our own subscription is ordinary SaaS billing.

- **Don't charge $5 one booking at a time.** Stripe takes ~$0.30 + 2.9% ≈ **$0.45 on a $5 charge (~9%)**. Roll per-booking fees into a **monthly invoice per venue** ("you booked 6 nights in June — $30"), turning six ~$0.45 hits into one ~$1.17 hit.
- The $5/month subscription is a single recurring charge; trivial.
- Billable event = the on-platform **offer-accept** (the `confirmed` transition). We don't need to process the gig payment to know a booking happened.

## 6. Open levers (decide at momentum, not now)

1. **Flat-only vs flat + per-booking.** Lead with $5/month flat for simplicity; add the $5/booking lever only if high-volume venues should pay proportionally more.
2. **Does free ever end?** It's plausible the cost base stays low enough that some venues never cross a paywall. Acceptable — liquidity over margin.
3. **When the payments rail comes back,** it returns as an *opt-in convenience* ("pay the act through Gigit"), not a mandate — and the pay-transparency and artists-free policies are unchanged by it.
4. **Promotion / syndication, sponsorships, venue SaaS add-ons** are all later, optional, and must never come at the supply side's expense (brand red line).

## 7. What this doc changes elsewhere (propagation checklist)

The reframe touches docs that were written around the payments moat. Tracked so they don't drift:

- [x] `PRD.md` — Mission section added; §4 rewritten; §1 framing fixed.
- [x] `PRD.md` — fully propagated: §2 goals, personas, §5 (now framed as an **asymmetric three-sided market** — venue + performer mandatory, tech a conditional/derived third side), §6 (F4 payments + e-sign contracts + fee schedule re-tagged **D = deferred**, with a new priority tier), §7 NFRs, §8 risk table (leakage/tax/revenue rows reframed; a "discovery-first captures less" row added), §10 launch plan (payments rail → Phase 2), §11 open questions (payments-turn-on + tech-seeding-ratio added).
- [x] `docs/brand.md` — premise leads with "more music"; "more music is the whole point" promoted to value #1; payment-timing claims (value #3, per-side props, cancellation-fee & dispute voice samples, §6 relationship promises) reworked to discovery-first; "never take a cut" added as a red line.
- [x] `docs/engineering-spec.md` / `docs/technical-design.md` / `docs/prd-coverage.md` — launch-posture banners added; money flows marked built-but-dormant; the deferral list is the launch configuration.
- [x] `README.md` / `docs/runbook.md` / `docs/testing.md` / `docs/m0-technical-spec.md` — swept: runbook no longer makes Stripe Connect a launch gate; testing no longer tiers the deferred Stripe path as highest-risk; m0 cancellation-fee contradiction fixed.
- [x] Code — explicit `PAYMENTS_ENABLED` flag (default off) + `paymentsEnabled()`; web UI, AI support KB, the performance agreement, and worker notification templates all render discovery-first copy when off. State machine / ledger / Stripe code untouched (dormant seam).
- [ ] Remaining (when convenient): a guard test asserting a full lifecycle moves no money under `PAYMENTS_ENABLED=off`; one stale ref in `research/agentic-outreach-wishlist.md` (the "free forever" lint example is now inverted — performers *are* free forever).
