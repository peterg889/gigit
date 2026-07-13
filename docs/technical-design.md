# Gigit — System Technical Design (as built + to build)

**Date:** June 2026. Component-level design for the whole system: what each component is, the exact interfaces by which components talk to each other, and the assumptions and requirements each one carries. Grounded in the code on `main` (post-M3), not the plan. Supersedes [`m0-technical-spec.md`](m0-technical-spec.md) (kept as the M0 historical record). Architecture rationale and the 11 commitments live in [`engineering-spec.md`](engineering-spec.md); requirement coverage and gaps in [`prd-coverage.md`](prd-coverage.md).

> **Launch configuration (discovery-first).** Gigit launches as a **discovery and coordination** platform and **does not touch the gig money** — the venue pays the act directly. The entire payments apparatus described below (Stripe Connect onboarding/KYC/payouts/escrow, the money-movement half of the booking state machine, the intent ledger + reconciliation, click-wrap/e-signed contracts, W-9/1099 tax, dispute money-resolution) is **built and seam-ready but switched OFF at launch** — it runs through `NullGateway` whenever `STRIPE_SECRET_KEY` is unset, so no real money moves. It turns on with venue monetization (Phase 2). This is a **seam, not a deletion**: the §-by-§ design below describes the *full* built system and remains accurate; the money paths are simply the dormant/deferred configuration. Source of truth for what is switched OFF vs ON: [`docs/pricing.md`](pricing.md) §4. What stays ON at launch: profiles, slots, feed/search/saved-searches, the apply→offer→accept handshake, messaging/inquiries, reviews + reliability, the sound-plan engine, tech sub-slots, recurring series, admin/ops, and the events outbox + analytics. Cancellations still reopen the slot and apply a reliability strike; only the monetary fee schedule is deferred.

---

## 1. Component inventory

| Component | Kind | Lives in | Talks to |
|---|---|---|---|
| **domain** | pure TS library (zero I/O) | `packages/domain` | imported by db, web, worker |
| **db** | data + integration layer | `packages/db` | Postgres; Stripe, Gemini (as gateway impls); imported by web, worker |
| **web** | Next.js App Router service | `apps/web` | db, domain; S3 (presign); browsers; Stripe webhooks in |
| **worker** | Node background service | `apps/worker` | db, domain; Twilio, SES, Stripe (via gateway) out |
| **infra** | CDK (TypeScript) | `infra/cdk` | provisions everything above on AWS |
| Postgres 16 | datastore | RDS / docker | single source of truth; also the queue (pg-boss) and the outbox |
| Stripe Connect | external | — | charges, transfers, refunds, Express onboarding, webhooks — **deferred at launch** (discovery-first; reached only via `NullGateway` until venue monetization, see pricing.md §4) |
| Twilio | external | — | outbound SMS (inbound SMS: to build, §7.3) |
| AWS SES | external | — | outbound email |
| Gemini API | external | — | all LLM tasks, only via the db package's AI gateway |
| S3 + CloudFront | external | — | media storage and delivery |

**Dependency rule (enforced by convention, verify in review):** `domain` imports nothing internal; `db` imports `domain`; apps import both; apps never import each other. All external services are reachable *only* through a db-package gateway (`paymentGateway()`, AI task functions) or a worker sink (notifications) — never called inline from routes.

## 2. The communication fabric

Three mechanisms connect the components. Everything else is a function call.

1. **Shared Postgres, transactional writes.** Web and worker both use `db()` (pg Pool, max 10, Drizzle). State changes that matter go through `runBookingTransition()` / `createOffer()` so that the row update, ledger entries, and outbox event commit atomically.
2. **The `events` table (outbox + audit + analytics).** Producers call `appendEvent(txOrDb, {actor, kind, subjectType, subjectId, payload})` *inside the same transaction* as the state change. The worker polls `dispatched_at IS NULL` (1s interval, batch 50, `FOR UPDATE SKIP LOCKED`), interprets `payload.effects[]`, and marks dispatched. Delivery is at-least-once; every consumer is idempotent.
3. **pg-boss for scheduled work only** (queue `booking-timers`): jobs `{bookingId, fire}` with `singletonKey = bookingId:job` and `retryLimit 5`. Used where time, not a transaction, is the trigger. Because a post-commit enqueue can be lost, a **reconciler loop** (10 min) re-derives due timers from booking state — timers are a cache; booking rows are the truth.

**Effect vocabulary** (produced by the domain reducer, persisted in event payloads, interpreted by the worker):

| Effect | Interpreter action |
|---|---|
| `schedule {job, runAt}` | `boss.send('booking-timers', {bookingId, fire}, {startAfter, singletonKey})` |
| `cancel_schedule` | no-op (stale timers are idempotent no-ops on arrival) |
| `request_payment` | `paymentGateway().charge(bookingId)`; Null gateway → immediate `PAYMENT_SUCCEEDED` transition; Stripe → pending, webhook closes the loop |
| `release_funds {amountCents}` | `paymentGateway().transfer(...)` |
| `refund_funds {amountCents}` | `paymentGateway().refund(...)` |
| `cancellation_fee {feeCents, refundCents}` | transfer + refund as applicable |
| `notify {template, to}` | `notifyBookingParties(bookingId, template, to)` |
| `reopen_slot`, `reliability_strike` | no-op in worker — already applied in-transaction by the transition runner |

**Dormant at launch (discovery-first):** the four money effects — `request_payment`, `release_funds`, `refund_funds`, `cancellation_fee` — are emitted by the reducer exactly as described but are interpreted through `NullGateway` no-ops, so no real money moves (no Stripe key set). `reopen_slot` and `reliability_strike` stay fully live — cancellations still reopen the slot and strike reliability; only the monetary effects are deferred until venue monetization (pricing.md §4).

## 3. Interface contracts between components

### 3.1 domain → consumers
- `decide(snapshot, event, now) → {next, effects[]}` or throws `IllegalTransitionError`. Pure; the only place booking rules live. States: `offered → confirming → confirmed → awaiting_confirmation → released`, branches `collapsed | disputed | cancelled_by_venue | cancelled_by_performer | refunded | partially_released`. Events: `PERFORMER_ACCEPTED, PAYMENT_SUCCEEDED, PAYMENT_FAILED, OFFER_EXPIRED, GIG_ENDED, PERFORMER_MARKED_PLAYED, VENUE_CONFIRMED, AUTO_CONFIRM_ELAPSED, DISPUTE_OPENED, DISPUTE_RESOLVED, VENUE_CANCELLED, PERFORMER_CANCELLED`.
- `venueCancellationFee(amount, gigStart, cancelledAt)` — >14d: 0%; 48h–14d: 50%; <48h: 100% to performer. `performerCancellationFee` — always full refund to venue.
- `soundPlan(venuePA, performerNeeds) → {version: 0, verdict: covered|tech_needed|tech_and_rig_needed, gaps[]}` — deterministic, versioned.
- `renderAgreement(venueName, performerName, terms) → string` + `AGREEMENT_TEMPLATE_VERSION` ("v1") — both parties accept this exact text; version recorded on the booking.
- Zod schemas for every API input; branded ULID id types via `newId(kind)`.
- **Constants doubling as contracts:** `AUTO_CONFIRM_HOURS = 24`; offer expiry 72h (set at `createOffer`).

### 3.2 db → consumers
- `runBookingTransition(bookingId, event, actor, now?) → {bookingId, from, to, effects[]}`. One transaction: `SELECT … FOR UPDATE` → `decide()` → `UPDATE … WHERE version = old` (else `ConcurrentUpdateError`) → in-tx ledger rows for money effects → in-tx slot reopen / strike / fill+decline-others → `appendEvent('booking.transition')`. Throws `BookingNotFoundError | ConcurrentUpdateError | IllegalTransitionError`; callers map these to 404/409/409 (web) or log-and-skip (worker, stale timer).
- `createOffer(input) → bookingId` — booking `offered` + application `offered` + `booking.offered` event with `offerCreatedEffects` (expiry timer + notify), atomically.
- `recordLedgerEntry(tx, {bookingId, entryType, debitParty, creditParty, amountCents, paymentRef?, idempotencyKey?})` — append-only; key defaults to `bookingId:entryType`; `ON CONFLICT DO NOTHING`. Invariant at terminal states: `charged == released + refunded` per booking (`bookingLedger()` computes the triple).
- `paymentGateway() → {charge, transfer, refund, connectOnboardingLink}` — `NullGateway` when `STRIPE_SECRET_KEY` unset (charge auto-succeeds, refs `null_pi_*`), `StripeGateway` otherwise (PaymentIntent off-session; outcome via webhook; idempotency keys on every call). `constructStripeEvent(body, sig)` verifies webhook signatures. **At launch (discovery-first) this is the deferred configuration:** no Stripe key is set, so the gateway is `NullGateway` and every money call is a no-op; `StripeGateway` is the dormant path that turns on with venue monetization (pricing.md §4).
- AI tasks — `profileIngest(url, userId)`, `slotParse(text, userId)`, `gearExtract(description, userId)`. Common contract: structured-output Gemini call (`GEMINI_MODEL`, temp 0.2, 20s timeout, responseSchema), zod-validated, **always logged to `ai_tasks`** (input/output/model/promptVersion/status) + `ai.task` event; user content enters prompts as fenced data; output is a *draft* the human must confirm; no key → heuristic fallback (`profileIngest` only) or `AiNotConfiguredError`.
- `appendEvent`, `env()` (zod-validated, fail-fast), `db()/getPool()/closeDb()`, seed.

### 3.3 web → browser (HTTP API)
Full route table in the M0 spec plus, as built since: `applications/[id]/status` (decline/withdraw), `bookings/[id]/{mark-played, dispute, review, agreement}`, `admin/disputes/[id]/resolve`, `media/presign|embed|[id]/upload|[id]/complete|file/[name]`, `ai/{profile-ingest, slot-parse, gear-extract}`, `payments/connect`, `calendar` (signed iCal), `webhooks/stripe`, `techs/list`. Conventions: zod `parseBody`; `{error:{code,message}}` failures; session = `gigit_session` httpOnly JWT (HS256, 30d, `{sub: userId}`), roles re-read from DB per request; ownership helpers (`performerOwnedBy` etc.); `isAdmin` via `actor_roles`. Rate limits: OTP 5/destination/hour; inquiries 10/user/day.

### 3.4 web ← external (webhooks)
`POST /api/webhooks/stripe`: verify signature → dedupe by event id in `webhook_events` → map `payment_intent.succeeded|payment_failed` (+ `metadata.bookingId`) to `PAYMENT_SUCCEEDED|PAYMENT_FAILED` transitions → swallow `IllegalTransitionError` (stale replays OK), rethrow anything else → unknown event kinds recorded, never dropped. **Requirement:** the worker has no inbound surface; all webhooks terminate at web.

### 3.5 worker → external
`notifyUser(userId, template)`: SMS via Twilio REST if phone + Twilio configured, else SES email if configured, else structured-log sink. 14 versioned templates in-repo (offer_received, booking_confirmed, offer_expired, offer_withdrawn, payment_failed, mark_played_prompt, payment_released, venue_cancelled, performer_cancelled, dispute_opened, dispute_resolved, new_application, new_inquiry, new_message). Money movement through `paymentGateway()` only.

### 3.6 Media path
Presign (`media/presign`: type/size/quota checks — images ≤10MB ×20, audio ≤25MB ×10, embeds ×5) → client PUTs to S3 presigned URL (prod) or `media/[id]/upload` (dev local driver, `.data/uploads`) → `media/[id]/complete` flips `processing → ready` (fraud-screen seam, currently a stub — §7.4). Embeds: host allow-list (YouTube/Vimeo), oEmbed metadata fetch (4s timeout, non-fatal). Delivery: `publicMediaUrl()` → `MEDIA_CDN_URL` (CloudFront) or presigned GET; local route in dev.

## 4. Component designs (responsibilities, assumptions, requirements)

### 4.1 Identity & profiles (web routes + db tables)
One human = one `users` row (phone and/or email, unique). One profile per type per user via `ownerUserId` (multi-role = own one of each). **Assumptions:** profile data (`techNeeds`, `paInventory`) is structured enough for the sound-plan engine — garbage-in is that engine's only failure mode, so extraction-confirmation UX is part of this component. **Requirements:** profiles are public reads; contact info is never in profile payloads; `reliability_strikes` only mutated by the transition runner.

### 4.2 Auth (web)
OTP: `auth/request` (rate-limited, dev code `000000`, delivery via outbox → worker) → `auth/verify` (TTL 10 min, ≤5 attempts, consumed-once) → upsert user → JWT cookie. **Requirements:** no passwords anywhere, ever (K6); `SESSION_SECRET` ≥32 chars enforced at boot; cookie `secure` in prod; calendar-feed JWTs are scope-limited (`scope: "ical"`, 365d) and revocable by secret rotation.

### 4.3 Marketplace: slots, feed, applications (web + db)
Slots require budget (transparency is policy, enforced in schema), future-dated, carry `metro` and `source: web|sms|api`. Feed: open + future, filters format/metro, limit 100. Applications unique per (slot, performer); applicant list is venue-owner-only. **Assumptions:** single metro, hundreds of bookings/month — SQL filters suffice; index `(status, startsAt)` carries the feed. **Requirements (unmet, §7):** radius + ranking (F2.7), saved-search alerts (F2.3), venue→performer search (F2.4), recurrence (F2.2).

### 4.4 Booking & contracts (domain + db + web)
See §3.1/§3.2. Click-wrap: agreement text rendered from terms at `v1`; acceptance timestamps (`venueAcceptedAt`, `performerAcceptedAt`) + template version on the booking row; accept route records both. **At launch (discovery-first), the click-wrap / e-signed contract layer is deferred** (pricing.md §4): the booking record plus a plain terms summary (budget, date, room details) is the receipt of the handshake; the rendered-agreement + dual-acceptance machinery is built and stays ready, turning on with venue monetization. **Requirements:** terms immutable after offer (change = new offer); all transitions audit to `events`; web maps domain errors to 4xx — never retries a 409 blindly. **Assumption to fix (§7.6):** acceptance should be gated on performer Stripe onboarding.

### 4.5 Media (web + S3/CloudFront + worker seam)
§3.6. **Requirements:** nothing public before `ready`; per-file caps at presign time; S3 lifecycle aborts stale multiparts (2d, in CDK). **Unmet requirements (§7.4):** processing between upload and `ready` is currently a no-op — EXIF strip, renditions, sniffing, virus scan, fraud screen all land there; embed-rot recheck job.

### 4.6 AI gateway (db) — K9
§3.2. Three tasks built; registry designed for seven (engineering spec §9). **Requirements:** no model call outside the gateway; every call logged + cost-meterable; prompt changes gated on golden-set evals in CI (**evals not yet present — §7.8**); the invariant "nothing AI-generated reaches another user or a state machine without schema-validated determinism or human approval" holds today because all three tasks return drafts to their requester. **Assumptions:** Gemini structured output is reliable at temp 0.2; 20s timeout acceptable because all calls are interactive-draft, never booking-critical.

### 4.7 Comms: threads + iCal (web)
Threads scoped `inquiry|application|booking|support`; participants explicit; inquiry creation is atomic (thread + participants + first message + notify event). Direction rules: venue→performer/tech, performer→tech; no performer→venue cold contact. **Requirements (partially unmet):** contact reveal at `confirmed` (template-driven) and mute/block are designed but not built; daily inquiry cap enforced at creation.

### 4.8 Payments (db gateway + worker + Stripe)
**Deferred at launch (discovery-first).** This whole component is built and seam-ready but switched OFF in the launch configuration: no Stripe key → `NullGateway` → no real money moves; the venue pays the act directly off-platform. Everything below describes the dormant configuration that turns on with venue monetization (pricing.md §4). §3.2/§2. Charge on `confirming`, funds to platform balance, transfer on `released`, fees as partial transfer + partial refund. Ledger = intent record; Stripe = movement record; **nightly reconciliation diffing the two is designed, not built (§7.7)**. **Requirements:** every money effect has a ledger row before the external call; idempotency keys on both layers; Express is the only payout path (keeps 1099-K on Stripe). **Assumptions:** card-default at MVP (open Q#1); venue payment-method capture (SetupIntent + Elements) must exist before live charges — currently absent (§7.6).

### 4.9 Notifications (worker)
§3.5. **Requirements:** templates versioned in-repo; URLs substituted from `APP_URL`; critical-path templates must go SMS-first. **Unmet:** day-before reminder (needs a timer, not just an event), channel prefs, PWA push.

### 4.10 Sound plan (domain + web)
Engine v0 (§3.1) surfaced on slot detail, computed on read from venue `paInventory` × performer `techNeeds`. **Asymmetric three-sided market (PRD §5):** venue + performer are the *mandatory core* — no show exists without both — while the **sound tech is a conditional, derived third side**, engaged only on the subset of bookings this engine flags as uncovered (`tech_needed` / `tech_and_rig_needed`). Tech is therefore *derived demand*, measured by **attach rate on tech-needed bookings**, not by raw tech count; most shows never generate a tech sub-slot at all. **Assumption:** recompute-on-read is fine until sub-slots need a *persisted* plan snapshot at booking time (do that when §7.2 lands). Fixture library of real rigs is the test strategy (engineering spec §13) — keep growing it.

### 4.11 Reviews & disputes (web + db + domain)
Reviews: one per (booking, authorRole), terminal bookings only, visible when both submitted or +7 days (read-side rule). Disputes: `DISPUTE_OPENED` pauses release; admin resolution is a discriminated union (`release_full | refund_full | partial` with sum validation) driving `DISPUTE_RESOLVED` to `released | refunded | partially_released`. **Requirement:** payout mathematically cannot release while `disputed` (state machine guarantees it). **At launch (discovery-first), dispute money-resolution is deferred** (pricing.md §4): with no money on-platform there is no payout to move, so disputes are handled reputationally — a lightweight report/flag that holds reviews and feeds reliability. The `release_full | refund_full | partial` resolution engine is built and stays ready, turning on with venue monetization.

### 4.12 Admin (web)
`/admin` liquidity dashboard (SQL over events/ledger/domain tables) + dispute resolution. Admin = `actor_roles.kind='admin'`, granted out-of-band. **Unmet (§7.5):** search, manual ops, moderation queue.

### 4.13 Worker process shape
Single Node process: outbox loop (1s) + pg-boss timers + reconciler (10 min); JSON logs; SIGTERM/SIGINT graceful drain. **Requirements:** every handler idempotent; stale timer = logged no-op; crash-restart must lose nothing (M0 exit criterion 4 — outbox rows and booking state survive; reconciler re-arms).

### 4.14 Infra (CDK) & delivery
Two stacks (staging/prod, separate accounts): App Runner web (auto-deploy on ECR push; prod 1vCPU/2GB), one t4g.small EC2 running the worker container (`--restart=always`, redeploy via SSM), RDS Postgres 16 single-AZ (prod: 14d backups, deletion protection), S3+CloudFront (OAC, no public bucket), SES send rights on the worker role, Secrets Manager (`DATABASE_URL`, `SESSION_SECRET`, Stripe, Twilio — manual fill). CI (GitHub Actions): typecheck + tests against a Postgres service + web build. **Requirements (unmet):** the deploy stage (build images → push ECR → migrate → staging → manual promote) is not in CI (§7.9); no Sentry/alarms/uptime checks (§7.9); tighten S3 CORS to `APP_URL` post-DNS. **Assumptions:** public-subnet RDS/EC2 with SG restriction is acceptable at this scale (revisit before sensitive-data growth); single-AZ accepted per K11.

### 4.15 Configuration contract
From `env()` (zod, fail-fast): required `DATABASE_URL`, `SESSION_SECRET`; defaulted `APP_URL`, `STORAGE_DRIVER=local`, `AWS_REGION`, `GEMINI_MODEL`; optional-with-fallback `STRIPE_SECRET_KEY(+_WEBHOOK_SECRET)` → Null gateway, `GEMINI_API_KEY` → heuristic/503, `TWILIO_*`/`EMAIL_FROM` → log sink, `S3_BUCKET` (required iff s3), `MEDIA_CDN_URL`. **Design property:** the system boots and demos with *zero* external credentials; every external dependency has a local stand-in. **Known footgun:** nothing loads `.env` for `db:seed`/CLI scripts (Next loads it for web only) — export vars or add dotenv to the db package scripts.

## 5. Cross-cutting assumptions & requirements register

| # | Statement | Type | Holds today? |
|---|---|---|---|
| A1 | Postgres is the only datastore; queue, outbox, audit, search all live in it until measured pain | assumption | ✅ |
| A2 | At-least-once delivery everywhere; therefore every consumer idempotent (singleton keys, idempotency keys, version checks, stale-no-op) | requirement | ✅ |
| A3 | LLM output never directly triggers a money/state transition | requirement | ✅ (drafts only) |
| A4 | All times UTC in storage; venue IANA timezone for rendering/scheduling | requirement | ✅ venue-local rendering, input conversion, recurrence, SMS, and calendar location |
| A5 | Single region, single metro; `metro` is a column, not a deployment | requirement | ✅ |
| A6 | Σ ledger = 0 per booking at terminal states; no transfer without a ledger row | requirement | ✅ in code; **deferred at launch** — discovery-first means no money moves, so the ledger carries no real entries (NullGateway); reconciliation job missing (pricing.md §4) |
| A7 | 1–3 engineers; two deployable units max | constraint | ✅ |
| A8 | Volume ~hundreds of bookings/month; design ceiling 100×; recompute-on-read and SQL-over-events are fine | assumption | ✅ |
| A9 | Webhooks terminate at web; worker has no inbound surface | requirement | ✅ |
| A10 | Nothing publishes media before screening | requirement | ❌ screening is a stub (§7.4) |
| A11 | Stripe Express is the sole payout path (tax delegation depends on it) | requirement | ✅ structurally; **deferred at launch** — no on-platform payouts in the discovery-first config, so this holds dormant; acceptance gate missing (§7.6); turns on with venue monetization (pricing.md §4) |

## 6. Canonical interaction flows

**6.1 Offer → released (happy path):** apply (INSERT) → `createOffer` (booking `offered`, expiry timer + notify via outbox) → worker schedules timer, notifies performer → accept route: `PERFORMER_ACCEPTED` → `confirming`, effects `[cancel_schedule, request_payment]` → worker charges; Null: immediate `PAYMENT_SUCCEEDED`; Stripe: webhook → `confirmed` (charge ledgered; slot `filled`; rival applications declined; `gig_ended` timer) → timer `GIG_ENDED` → `awaiting_confirmation` (+24h auto-confirm timer, mark-played prompt) → performer marks played / venue confirms / 24h elapses → `released` (release ledgered) → worker transfers → notify. **At launch (discovery-first), the charge and transfer/release steps are `NullGateway` no-ops** — `request_payment` auto-succeeds with no money moving, so the booking confirms instantly on accept and the flow proceeds through `released` purely as a coordination/state record (the venue pays the act off-platform). The charge/release ledger and Stripe legs are dormant until venue monetization (pricing.md §4).

**6.2 Venue cancels at T−36h:** `VENUE_CANCELLED` → `cancelled_by_venue`; in-tx: fee ledger rows (50/50 at this window), slot reopened; worker: transfer fee + refund remainder + notify.

**6.3 Dispute:** either party in `awaiting_confirmation` → `disputed` (release timer becomes no-op) → admin resolves → `released | refunded | partially_released` with validated sums → worker moves money accordingly.

**6.4 AI draft (any task):** user input → web AI route → db gateway → Gemini (or fallback) → zod parse → `ai_tasks` log + event → draft returned → human edits/approves → ordinary POST creates the real entity (`source`/`profile_source` records provenance).

## 7. Components to build (each is design-ready; PRD refs in `prd-coverage.md`)

1. **Recurrence** (F2.2): `slot_series(id, venue_id, rrule_or_pattern, defaults jsonb, status)`; materialize next N occurrences as ordinary `slots` rows (lean from open Q#3) via a worker job; per-occurrence override = edit the slot row; series cancel = cancel future unfilled occurrences. *Decide representation first.*
2. **Tech sub-slots** (F6.2/6.3): `tech_subslots(id, booking_id, payer, budget_cents, needs jsonb, tech_id?, state)` running the **same** reducer with `payer` parameterizing charge source; appears in tech feed; inherits room/inputs/set-times from the parent booking + persisted sound-plan snapshot; venue cancellation cascades at the same fee schedule; tech reviews ride the existing reviews table with a `tech` role.
3. **SMS surface** (F2.8): Twilio inbound webhook at web → `sms_sessions(phone, active_context)` router → STOP/HELP first → active-thread reply | `slot_parse` for venue numbers | support; confirmation loop closes by SMS reply. Gated on A2P 10DLC — register now.
4. **Media pipeline + fraud screen** (F7.5, A10): worker job on upload-complete: content-type sniff, virus scan, EXIF strip, sharp renditions, `media_fraud_screen` AI task → `fraud_flags` table → ops queue; auto-block only at very high confidence; embeds screened on oEmbed metadata; weekly embed-rot recheck.
5. **Ops console** (F9.1/9.3): user/booking search, manual transition (admin-actor events), refund/hold buttons (ledgered adjustments), suspension flag enforced at apply/offer/accept, moderation queue over `fraud_flags` + reports.
6. **Payment hardening**: venue SetupIntent + Elements capture; accept-gate on performer `stripeAccountId` payouts-enabled; `band_members(performer_id, user_id, payout_split_bps)` table now (unused until P1).
7. **Reconciliation + observability**: nightly ledger-vs-Stripe diff (page on mismatch); Sentry web+worker; uptime checks on web + webhook endpoint + queue-depth/outbox-lag metrics; CloudWatch alarms.
8. **AI completions**: photo input for `gear_extract`; `support_triage` (KB-grounded, auto-send only KB-grounded answers) + `dispute_brief`; golden-set eval harness in CI + injection corpus; richer `profile_ingest` draft (media links, set lengths, tech needs).
9. **Delivery pipeline**: CI deploy stage — build/push images, run migrations, staging auto-deploy, manual prod promote; backup-restore drill; load test at 100×; on-call runbook.
10. **Discovery v1 completion** (F2.3/2.4/2.7): haversine radius + recency/reliability ranking in feed; `saved_searches(id, performer_id, filters jsonb)` + matcher job on `slot.created` events → notify; venue-facing performer search + invite-attached-to-slot (inquiry thread + slot ref).
11. **Small P0 content/polish**: PRO-licensing static guidance in venue onboarding; day-before-reminder timer; contact reveal at `confirmed`; PWA manifest + push; review rating dimensions per PRD; `venue_night_facts` nightly snapshot (cheap, unbackfillable — do early).
