# Gigit — System Architecture & Engineering Spec (v0.1)

**Date:** June 2026
**Scope:** Technical design for the PRD's P0 (MVP) scope with explicit seams for P1/P2. Companion to [`PRD.md`](../PRD.md).
**Team assumption:** 1–3 engineers, AI-accelerated, one launch metro, ~hundreds of bookings/month at launch. Design target: support 100× launch volume without re-architecture; explicitly NOT designed for 10,000×.

> **Launch posture (discovery-first).** Gigit launches as discovery and coordination and **does not process gig money** — the venue pays the act directly, the way they already do. The entire payments apparatus described below (Stripe Connect onboarding/KYC/payouts/escrow, the money half of the booking state machine, the intent ledger + reconciliation, click-wrap/e-signed contracts, W-9/1099 tax, and dispute *money*-resolution) is **designed, seam-ready, and switched OFF at launch** — it turns on with venue monetization in Phase 2. This is a **seam, not a deletion**: the architecture here is real and correct; what changes is which configuration is the launch default. The seam already exists in code (`NullGateway` when `STRIPE_SECRET_KEY` is unset). Source of truth for what defers and why: [`docs/pricing.md`](pricing.md) (esp. §4 the deferral table, §5 billing mechanics) and [`PRD.md`](../PRD.md) §4. Everything *not* money — profiles, slots, feed/search/saved-searches, the apply→offer→accept handshake, messaging, reviews + reliability, the sound-plan engine, tech sub-slots, recurring series, admin/ops, the `events` outbox — stays **on**.

---

## 1. Design principles

1. **Deterministic core, AI at the edges.** Money movement, booking state, scheduling, and matching eligibility are deterministic, testable code. LLMs do extraction (photo→specs, link→profile), drafting (messages, contracts summaries), classification (support triage, fraud flags) — always producing *proposals* that flow through typed validation and, where user-facing, human confirmation. An LLM output is never the direct trigger of a state transition involving money.
2. **One database, one writer model.** Postgres is the single source of truth. Anything that looks like a second datastore (search index, vector store, queue, audit log) starts as a Postgres feature (FTS, pgvector, pg-boss/LISTEN-NOTIFY, append-only tables) until measured pain says otherwise.
3. **The booking state machine is the product.** Most defects that kill trust (double-charge, orphaned gig, payout to the wrong party) are state-machine defects. It gets the most rigorous treatment in the codebase: explicit states, guarded transitions, exhaustive tests, an audit event per transition.
4. **Boring choices everywhere we're not differentiated.** Differentiation lives in the sound-plan engine, the AI workflows, and marketplace liquidity — not in infrastructure. Managed services, one region, no Kubernetes.
5. **Every external effect is idempotent and replayable.** Stripe webhooks, Twilio inbound, AI job retries — all keyed, all safe to re-run. The outbox pattern for everything we emit.
6. **Design for deletion.** P2 features (native apps, ticketing, ML matching) must not leave skeletons in the MVP. Seams, not stubs.

## 2. The commitments (decisions that are expensive to reverse)

| # | Commitment | Rationale | Reversal cost |
|---|---|---|---|
| K1 | **TypeScript monorepo, modular monolith.** Next.js (App Router) for web + API routes for simple reads; a single Node worker service for jobs/webhooks/state transitions. Shared `packages/domain` holds the state machines and types. | One language across web/worker/AI glue; smallest team surface. Modules (booking, payments, profiles, ai, comms) are enforced-boundary folders, not services. | Low→medium; modules are extraction-ready |
| K2 | **Postgres (managed, e.g. Neon/RDS) + Drizzle ORM; pg-boss for job queue; pgvector for embeddings; PostGIS for geo.** No Redis, no Elasticsearch, no Kafka at MVP. | Fewer moving parts; transactional job enqueue (job row commits atomically with the state change that caused it) eliminates a whole class of dual-write bugs. | Medium (queue swap is contained behind one interface) |
| K3 | **Stripe Connect Express accounts** for performers/techs; destination charges with `manual` payouts pattern: charge venue at confirmation → funds in platform balance → transfer on release. Stripe is the ledger of record for money *movement*; our append-only `ledger_entries` table is the ledger of record for money *intent* (who is owed what and why). **DEFERRED at launch** — built and seam-ready (`NullGateway` when `STRIPE_SECRET_KEY` is unset), switched off for the discovery-first launch; turns on with venue monetization in Phase 2 (see launch-posture note, [`docs/pricing.md`](pricing.md) §4). | Express gives us hosted KYC onboarding, W-9/TIN collection, and 1099-K generation — that's PRD F4.4 nearly for free. The internal intent-ledger is cheap now and unretrofittable later (splits, refund partials, disputes all need it). | High — chosen deliberately; Custom accounts only if white-label onboarding becomes a conversion problem |
| K4 | **Booking lifecycle as an explicit persisted state machine** (states enumerated §5) with transitions only via `transition(bookingId, event, actor)` — one function, one audit row, one outbox row, atomically. | See principle 3. | High — this IS the architecture |
| K5 | **Append-only `events` table (outbox + audit + analytics) from day one.** Every domain event (state transitions, messages, AI decisions, money intents) is a row; consumers (webhooks out, notification fan-out, the future warehouse) read from it. | PRD requires audit (disputes, F7.4), the ROI loop needs historical baselines from MVP (F8.5), and analytics shouldn't require instrumentation archaeology later. | High to retrofit, trivial to start |
| K6 | **Phone-first passwordless auth** (SMS OTP, email magic-link fallback). Sessions via secure cookies; no passwords ever stored. | SMS is a first-class product surface (F2.8); venue managers are phone people; passwords are support debt. | Low |
| K7 | **Contracts = versioned click-wrap, not e-signature SaaS.** Agreement text rendered from booking terms + template version; both parties accept in-flow; acceptance event (user, IP, timestamp, template hash) recorded. No DocuSign. **DEFERRED at launch** — the click-wrap performance agreement turns on with payments in Phase 2; until then the booking record + plain-terms summary (PRD F3.2) is the receipt, and the deal closes on the mutual accept. | Click-wrap with audit trail is legally sufficient for these agreement values; e-sign SaaS adds cost and flow friction. | Low (can add e-sign for high-value bookings later) |
| K8 | **Media kept simple: photos and audio tracks uploaded natively (stored as-is, no transcode service); video via YouTube/Vimeo embed only (§8).** S3 + CloudFront; image renditions via sharp in the worker; MP3/M4A served directly. | Photos have no embed alternative; audio-as-is costs pennies and needs no pipeline; video was the only media demanding a transcode service (MediaConvert) — embeds delete that entire subsystem. `profile_ingest` (F1.8) finds artists' existing YouTube links automatically, so the embed requirement costs performers nothing. | Low |
| K9 | **All LLM use flows through one internal `ai` module** ("AI gateway"): task registry, repo-versioned prompts, zod-validated structured outputs, per-task model routing, full I/O logging to `events`, cost metering, golden-set eval harness in CI. No ad-hoc model calls anywhere else in the codebase. | Centralizes safety (injection surface, output validation), cost control, and the PRD's draft-never-publish invariant; makes model swaps a config change. | High to retrofit |
| K10 | **Single region, single metro-aware schema.** Every domain row carries `metro_id`; no per-metro databases, no sharding. | Metro #2 must be an INSERT, not a deployment. | Low |
| K11 | **AWS-native but minimal, IaC in CDK (TypeScript): one x86 `t3.small` EC2 host runs the web and worker linux/amd64 containers — no Fargate, cluster, or NAT gateway.** CloudFront provides the public HTTPS origin in front of a public ALB; the ALB permits only the CloudFront origin prefix and a generated verification header. The host sits in a public subnet for direct internet-gateway egress, has no SSH ingress, and accepts its web port only from the ALB security group; the worker has no inbound surface. RDS Postgres is encrypted, single-AZ, and in private-isolated subnets. S3 + CloudFront, SES, Secrets Manager, CloudWatch, and GitHub Actions OIDC complete the staging stack; production is an optional, manually gated per-account deployment. | One small host is the lowest-cost shape a 1–3 person team can operate. Web and worker remain separate containers, so moving either to a second host or managed compute later is a CDK change rather than an application redesign. | Low |

> **2026 deployment constraint:** AWS App Runner stopped accepting new customers on March 31, 2026, and this AWS account has no recorded App Runner usage before that cutoff. The EC2/ALB/CloudFront shape is therefore the dependable first-deploy path, not a speculative optimization. See the [AWS App Runner availability notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).

## 3. System overview

```
   Performers / Venues / Techs
                │ HTTPS
                ▼
        CloudFront (web TLS) ─────────────── CloudFront (media) ◀── private S3
                │
                ▼
        Public application load balancer
                │ web port; ALB security group is the only inbound source
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Public-subnet x86 t3.small EC2 host (no SSH; internet-gateway egress)       │
│                                                                             │
│  web container — Next.js mobile web/API/webhooks                            │
│   • feeds, profiles, slots, booking flows, reviews, presigned S3 grants     │
│   • Stripe/Twilio webhooks verify, write, enqueue transactionally           │
│                                                                             │
│  worker container — no inbound surface                                      │
│   • pg-boss timers, outbox dispatch, notifications, AI and media jobs       │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ database security group only
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Private-isolated RDS Postgres                                               │
│ identity | profiles | marketplace | booking | money | comms | ai | events  │
│ PostGIS | pgvector | pg_trgm | pg-boss                                      │
└─────────────────────────────────────────────────────────────────────────────┘

The EC2 host reaches SES, Twilio, Gemini, Sentry, and other provider APIs through
its public route and internet gateway. No provider can initiate a connection to it,
and there is no NAT gateway.
```

Deploy: all infrastructure is AWS-native and defined in **CDK (TypeScript)**. CI uses GitHub Actions OIDC (no long-lived keys), runs typecheck/tests/builds, builds and pushes both linux/amd64 containers with an immutable `imageTag`, and deploys staging with a unique `deploymentNonce`. The nonce drives a CloudFormation-managed SSM association on the app host: pull the exact images, materialize `AppSecrets`, append the actual CloudFront `APP_URL`, run Drizzle migrations, then restart web and worker. CloudFormation generates the database credentials/`DATABASE_URL` and `SESSION_SECRET`, keeps provider secrets operator-managed, and sets `PAYMENTS_ENABLED=false` with empty Stripe values. Production is not an automatic promotion: an optional GitHub environment-gated job builds/pushes production images in that account and deploys them after manual approval. It does not retag or pull staging images across accounts.

## 4. Domain model (core tables, abridged)

```sql
-- identity & profiles ------------------------------------------------------
users            (id, phone, email, created_at, status)                  -- a human
actor_roles      (id, user_id, kind: performer|venue_member|tech|admin)  -- one human, many roles (PRD F1.1)
performers       (id, kind: band|solo|comedian|other, name, bio, genre_tags[],
                  home_metro_id, travel_radius_km, rate_min, rate_max,
                  set_lengths[], tech_needs jsonb, media_links jsonb,
                  profile_source: manual|ai_ingested, status: draft|pending_review|live)
band_members     (performer_id, user_id, role, payout_split_bps)         -- splits are P1; column ships day one (K3)
venues           (id, metro_id, kind, name, bio, geo point, capacity, room jsonb,
                  pa_inventory jsonb,                                     -- structured per F1.3/F6.6
                  hospitality jsonb, noise_curfew, booking_user_ids[])
techs            (id, user_id, bio, gear: none|partial|full_rig, rig_specs jsonb,
                  rate_labor, rate_with_rig, travel_radius_km)
coi_documents    (id, owner_role_id, file, insurer, expires_on, verified_by)
media_assets     (id, owner_role_id, kind: image|audio|video_embed,
                  s3_key?, bytes?, duration_s?,                           -- uploads (image/audio)
                  embed_url?, embed_meta jsonb?,                          -- video (YouTube/Vimeo oEmbed)
                  status: uploaded|processing|ready|rejected,
                  renditions jsonb {responsive[]}, fraud_screen_ref, position int)  -- §8; profile ordering

-- marketplace --------------------------------------------------------------
slot_series      (id, venue_id, recurrence rule, defaults jsonb, status)
slots            (id, venue_id, series_id?, metro_id, starts_at, duration,
                  format: music|comedy|either, genre_prefs[], budget_cents,   -- budget REQUIRED (transparency)
                  provides jsonb {pa, meal, parking}, status: draft|open|filled|expired|cancelled,
                  source: web|sms|api, sound_plan jsonb)                      -- computed, §7
applications     (id, slot_id, performer_id, note, status: submitted|withdrawn|declined|offered,
                  UNIQUE (slot_id, performer_id))
bookings         (id, slot_id, performer_id, state, terms jsonb,              -- §5 state machine
                  agreement_template_ver, accepted_at_venue, accepted_at_performer,
                  payment_intent_id, version int)                             -- optimistic locking
tech_subslots    (id, booking_id, payer: venue|performer, budget_cents, needs jsonb,
                  state)                                                      -- same machine, same rails
reviews          (id, booking_id, author_role, target_role, ratings jsonb, body,
                  visible_at)                                                 -- double-blind via visible_at
disputes         (id, booking_id, kind, opened_by, evidence jsonb, state, resolution jsonb)

-- money (intent ledger; Stripe holds the actual funds) -----------------------
ledger_entries   (id, booking_id?, entry_type: charge|hold|release|refund|fee|adjustment,
                  debit_party, credit_party, amount_cents, stripe_ref,
                  created_at, idempotency_key UNIQUE)                         -- append-only, no UPDATE/DELETE

-- comms ----------------------------------------------------------------------
threads          (id, scope: inquiry|application|booking|support, participant_role_ids[])
messages         (id, thread_id, sender_role_id?, ai_generated bool, body, channel: app|sms|email)
sms_sessions     (phone, active_context jsonb)                                -- conversational state for F2.8

-- ai --------------------------------------------------------------------------
ai_tasks         (id, task_type, subject_ref, input jsonb, output jsonb, model,
                  prompt_version, cost_usd, status: queued|done|failed|needs_review,
                  review: approved|edited|rejected, reviewer_id)
fraud_flags      (id, subject_ref, kind, confidence, evidence jsonb, state)

-- events (outbox + audit + analytics) — append-only ---------------------------
events           (id bigserial, occurred_at, actor, kind, subject_ref, payload jsonb,
                  dispatched_at)                                              -- partition by month from day one
```

Search/matching at MVP: SQL — PostGIS distance + format/genre array overlap + budget range + availability anti-join, ranked by reliability and recency. pgvector columns exist on `performers` (media embeddings) but ranking use is P1/P2. No external search engine.

## 5. The booking state machine (heart of the system)

```
SLOT:        draft → open → filled | expired | cancelled
APPLICATION: submitted → withdrawn | declined | offered

BOOKING:
  offered ──(performer accepts + both click-wrap)──▶ confirming
  confirming ──(PaymentIntent succeeded)───────────▶ confirmed          [charge venue NOW — K3]
  confirming ──(payment fails/timeout 24h)─────────▶ collapsed          [slot reopens, applicant notified]
  confirmed ──(clock: gig end)─────────────────────▶ awaiting_confirmation
  awaiting_confirmation ──(performer "played" + 24h no venue objection,
                           or venue confirms)──────▶ released           [transfer to performer/tech]
  awaiting_confirmation ──(either opens dispute)───▶ disputed
  disputed ──(ops resolution)──────────────────────▶ released | partially_released | refunded
  confirmed ──(venue cancels)──────────────────────▶ cancelled_by_venue [fee schedule: >14d 0% /
                                                      48h–14d 50% / <48h 100% — computed, ledgered, paid out]
  confirmed ──(performer cancels)──────────────────▶ cancelled_by_performer [full refund to venue,
                                                      reliability hit, urgent-refill job enqueued (P1)]
```

**Launch note (discovery-first).** The handshake path — `offered → confirmed`, plus the cancellation branches and clock-driven expiries — runs at launch. The **money path is dormant**: the `confirming` PaymentIntent step, the `awaiting_confirmation → released` fund release, and the `charge/release/refund/fee` ledger effects are seam-ready but switched off until venue monetization (Phase 2). With the gateway off, the lifecycle collapses to the handshake (`slot open → application → offer → confirmed → played | no_show`), `confirmed` is the terminal commercial state, and **cancellations move no money** — they still reopen the slot, notify, and apply a reliability strike (only the monetary fee schedule defers). See the launch-posture note and [`docs/pricing.md`](pricing.md) §4.

**Implementation rules:**
- One `transition()` function in `packages/domain`; transitions declared as data (state × event → guards, effects); illegal transitions throw before any I/O.
- Each transition runs in one DB transaction: state update (with `version` check), `events` row, `ledger_entries` row(s) if money intent changed, pg-boss enqueue for side effects. External calls (Stripe) happen in jobs *around* the machine: request → `confirming`; webhook → `confirmed`. The machine never blocks on the network.
- **Money invariants, property-tested** (these govern the money path, dormant at launch — they hold whenever the gateway is on): (1) Σ ledger entries per booking = 0 at terminal states; (2) `release` requires exactly one prior `hold` and no prior `release` (idempotency key = `booking_id + entry_type`); (3) no transfer without a ledger row; (4) refund + payout never both full. A nightly reconciliation job diffs ledger vs Stripe balance transactions and pages on mismatch.
- **Clock-driven transitions** (gig end, auto-confirm at +24h, offer expiry, slot expiry) are pg-boss scheduled jobs created at transition time, idempotent against the current state (a fired job on an already-moved booking is a no-op). All times stored UTC, rendered in venue's timezone; the metro's timezone is the scheduling default.
- Tech sub-slots run the same machine with `payer` parameterizing the charge source. A venue cancellation cascades to the attached tech sub-slot at the same fee schedule.

## 6. Payments detail

> **This entire section is the deferred configuration.** It is built and seam-ready but switched OFF at the discovery-first launch (the venue pays the act directly) and turns on with venue monetization in Phase 2 — see the launch-posture note and [`docs/pricing.md`](pricing.md) §4. The only money Gigit touches at launch is none; the only money it ever touches before this section turns on is its own venue subscription fee, via Stripe **Billing** (not Connect — [`docs/pricing.md`](pricing.md) §5).

- **Onboarding:** performer/tech completes Stripe Express onboarding before first *offer acceptance* (not at signup — don't tax registration). W-9/TIN, KYC, payout bank: all Stripe-hosted. We store only `stripe_account_id` + onboarding status.
- **Charge:** on offer acceptance → PaymentIntent (card or ACH; ACH gets a longer `confirming` window) on the venue's saved payment method, `transfer_group = booking_id`. Funds settle to platform balance.
- **Release:** transfer to connected account on `released`; band splits (P1) become N transfers computed from `band_members.payout_split_bps` — ledger rows per split from day one even while payout is single-target.
- **Refunds/fees:** cancellation fee schedule computed in domain code, expressed as ledger entries, executed as partial refund + partial transfer.
- **1099-K:** Stripe generates at federal thresholds; we enable state-level thresholds config (MA/MD/NJ etc.). Our job: nothing beyond keeping Express accounts the sole payout path.
- **Webhooks:** single endpoint, signature-verified, event-id idempotency table, fan-in to state machine events. Unknown events logged, never dropped silently.
- **PCI scope:** SAQ-A — Stripe Elements only; card data never touches our origin.

## 7. The sound-plan engine (deterministic core example)

**Why this engine matters structurally:** the market is an **asymmetric three-sided one (PRD §5)** — venue + performer are the mandatory two-sided core (no show without both), and the sound **tech is a conditional/derived third side**, engaged only for the bookings this engine flags as uncovered. The sound plan is therefore the gate that *summons* the tech side; it is derived demand, measured by **attach rate on tech-needed bookings**, not raw tech count. Most shows never trigger it.

Input: `venues.pa_inventory` (structured) × `performers.tech_needs` (structured). Pure function, versioned, unit-tested against a fixture library of real-world rigs:

```
soundPlan(venuePA, performerNeeds) → { verdict: covered | tech_needed | tech_and_rig_needed,
                                       gaps: [...], input_list: [...], notes: [...] }
```

- Verdict drives slot UX ("this gig needs sound — add a tech sub-slot?") and the tech brief (F-AI.12: the brief is a *template over structured data*, with an LLM polish pass that cannot alter facts).
- The AI's only role in this subsystem is **extraction**: photo/free-text → draft `pa_inventory`/`tech_needs` JSON (task `gear_extract`, §9), human-confirmed before the engine consumes it. Confidence below threshold → field left empty and asked explicitly. Garbage-in is the engine's only failure mode, so extraction review UX is part of this feature, not separate.

## 8. Media (photos + audio uploaded; video embedded — K8)

Profiles are the storefront. We host the two things that have no good embed story (photos, audio files) and embed the thing that does (video).

- **Photos (uploaded):** browser → presigned S3 POST (content-type/size constrained, quota-checked) → worker job: EXIF-strip + responsive renditions (sharp) → CloudFront. Venues upload room photos through the same path.
- **Audio (uploaded, stored as-is):** MP3/M4A, ≤25MB / ≤15 min per track, validated and served directly via CloudFront into an HTML5 player. **No transcode service** — what's uploaded is what plays. (Waveform rendering is a later nicety, computable in the worker if wanted.)
- **Video (embed-only):** YouTube or Vimeo URLs; we fetch oEmbed metadata, cache the title/thumbnail, and render the official embed player. No video storage, no MediaConvert, no transcode pipeline — most working acts already have a YouTube link, and `profile_ingest` (F1.8) discovers it automatically.
- **Screening before visibility:** uploads run `media_fraud_screen` (F7.5) + virus scan + content-type sniffing during processing; embeds are screened on their fetched metadata/thumbnail. `media_assets.status`: uploaded → processing → ready | rejected; nothing public until `ready`.
- **Delivery:** CloudFront over S3 — public cache paths for profile media, signed URLs for private documents (COIs, stage plots).
- **Quotas (config-driven):** ≈ 20 photos, 10 audio tracks, 5 video embeds per profile; per-file caps enforced at presign time.
- **Lifecycle:** S3 lifecycle rules purge abandoned multipart uploads and rejected assets (30 days); deletes cascade from profile edits and account deletion (§11). Embed rot (deleted YouTube videos) detected by a weekly oEmbed recheck job that flags dead links to the owner.

## 9. AI subsystem (the gateway — K9)

**Task registry (MVP):**

| Task | Trigger | Output contract (zod) | Human gate |
|---|---|---|---|
| `profile_ingest` (F1.8) | URL submitted | PerformerProfileDraft | owner approves every field before `live` |
| `slot_parse` (F2.8) | inbound SMS/free-text | SlotDraft + clarifying question if ambiguous | venue confirms before `open` |
| `gear_extract` (F6.6) | photos/free-text | PAInventoryDraft / RigSpecDraft | owner confirms |
| `media_fraud_screen` (F7.5) | media added | FraudFlag[] w/ confidence + evidence | flags → ops queue; auto-block only at very high confidence |
| `support_triage` (F9.4) | inbound support msg | reply draft from KB \| escalation packet | auto-send only for KB-grounded answers; everything else escalates |
| `dispute_brief` (F7.4) | dispute opened | evidence summary + drafted adjudication | ops decides; AI never adjudicates |
| `contract_render` | booking confirmed | plain-English terms summary | deterministic template; LLM summary is advisory text only |

**Gateway rules:**
- Prompts live in `packages/ai/prompts/*` with semver; every `ai_tasks` row records prompt version + model + cost. Changing a prompt requires the golden-set eval (fixtures of real inputs → asserted output properties) to pass in CI.
- All outputs parse against zod schemas; parse failure = task failure, never a partial write.
- **Injection posture:** all scraped/user-submitted content enters prompts as fenced, role-separated data; tasks have no tool access beyond their declared inputs; outputs are data (JSON), never instructions; `support_triage` answers only from the embedded KB and refuses out-of-KB topics by contract.
- Per-task model routing (cheap model for triage/classification; frontier for ingestion/drafting) and a monthly budget cap with alerting (worker refuses new non-critical AI jobs past cap; booking-critical paths have no AI dependency by design).
- **The invariant, enforced in one place:** nothing AI-generated reaches another user or a state machine without either schema-validated determinism (sound brief polish) or explicit human approval (everything else).

## 10. Communications

- **Outbound:** notification fan-out consumes `events`; per-user channel prefs; critical path (offer, confirmation, day-before reminder, payment released) goes SMS + email + push(PWA); everything else digest-able. Templates versioned with the same discipline as prompts.
- **Inbound SMS (Twilio):** one webhook → `sms_sessions` router: replies to active thread context if one exists; otherwise `slot_parse` for venue numbers; otherwise support. STOP/HELP handled at the router before any logic (compliance).
- **In-app messaging:** thread-scoped (inquiry/application/booking/support); contact info auto-revealed at `confirmed` (PRD F5.1) by template, not by trusting users to share.
- **Direct inquiries ("message any band"):** a venue can open an inquiry thread with any performer — typically alongside an invite-to-slot, but free-form questions are allowed. Performers reply, decline, or mute/block. Anti-abuse: per-venue daily inquiry cap; the contact-info reveal rules apply unchanged. Inquiry threads convert in place to application/booking threads when a slot is attached. Performer→venue cold messaging stays **off** (performers reach venues by applying to slots) — pitch spam is the failure mode venue bookers hate most about email/Instagram today, and we won't recreate it.
- **iCal:** signed per-user feed URLs generated from bookings; revocable.

## 11. Security, privacy, compliance

- AuthZ: role-scoped access checked in the domain layer (not just routes); venues see applicant profiles, never contact info pre-confirmation; performers never see venue payment instruments.
- PII map maintained in repo (`docs/pii.md`): what we hold, where, retention. Deletion endpoint anonymizes user rows and strips PII from events payloads (events keep structural data — bookings/money history is legally retained).
- Media: secured by the §8 pipeline (content-type sniffing, EXIF-strip, virus scan, fraud screening before public visibility); CloudFront signed URLs for non-public assets (COIs, stage plots).
- Secrets in platform secret manager; no secrets in repo; quarterly key rotation checklist.
- Backups: managed Postgres PITR + nightly logical dump to object storage, restore-tested monthly (calendar reminder is part of this spec).
- Rate limits on auth, application, and messaging endpoints (abuse + scraping).
- Logging: no message bodies or PII in application logs; `events` is the audited store, access-controlled.

## 12. Observability & analytics

- Sentry (web + worker), structured JSON logs, uptime checks on web + webhook endpoints + queue depth.
- **Metrics from `events`, not from instrumentation:** liquidity dashboard (PRD F9.2 — fill rate, time-to-fill, application depth) is SQL over `events`/domain tables, materialized views refreshed hourly. The PRD §9 metrics each get a view at MVP — if a metric can't be computed, that's a missing event, fixed at the source.
- ROI-loop groundwork (F8.5-P0): nightly job snapshots booking-night facts per venue (day-of-week, format, budget, weather later) into `venue_night_facts` — the baseline table the Phase 2 POS comparison will join against.
- AI ops: per-task cost/volume/approval-rate dashboard; approval rate per task is the input to autonomy-graduation decisions.

## 13. Testing strategy

| Layer | Approach |
|---|---|
| State machine | Exhaustive transition-table tests + property tests (fast-check) on invariant set (§5); model-based test driving random event sequences asserting no illegal state or money invariant breach |
| Payments | Integration suite against Stripe test mode in CI (clock-skipping via test helpers): happy path, payment failure, both cancellation branches, dispute, refund math; nightly reconciliation tested with seeded mismatches |
| Sound-plan engine | Golden fixtures: ~50 real venue/performer combos with expert-asserted verdicts |
| AI tasks | Golden-set evals per task in CI (assert output *properties*, not exact text); injection test corpus run against every prompt change |
| Time | All clock-driven logic takes an injected clock; lifecycle tests run a full booking through simulated weeks in milliseconds |
| E2E | Playwright on the 5 critical journeys: post slot (web + SMS), apply→offer→accept→pay, tech attach, cancel w/ fees, review |

## 14. Build plan

> **MVP launch (M0–M3) is discovery-first** — no gig-money processing. The payments build (M1 below) is engineered and property-tested through the milestones so the seam stays whole, but it ships **dormant** (`NullGateway`) and **turns on with venue monetization in Phase 2**, not at launch. Sequenced here for build order, not launch order; see the launch-posture note, [`docs/pricing.md`](pricing.md) §4, and [`PRD.md`](../PRD.md) §10 (payments rail → Phase 2).

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Walking skeleton** (wk 1–3) | Auth, profiles with bios + photo upload + YouTube/Vimeo embeds + inquiry messaging, slot post/feed/apply, offer→accept with NO payments (terms recorded, pay-direct), events table, CDK + deploy pipeline to AWS | A real venue messages and books a real performer end-to-end in staging; events show the full story |
| **M1 — Money** *(built dormant; activates with Phase 2 venue monetization, not at MVP launch)* (wk 4–7) | Full state machine, Stripe Connect Express, charge/hold/release, ledger + reconciliation, cancellation fees, click-wrap contracts, critical-path notifications (SMS/email) | Property suite green; test-mode lifecycle incl. disputes and both cancel branches; reconciliation catches seeded faults. **The money path stays behind the gateway seam, off by default**; what launches is the handshake-only configuration (§5 launch note). Critical-path notifications ship live |
| **M2 — AI & the third side** (wk 8–11) | AI gateway + `profile_ingest`, `slot_parse` (SMS posting), `gear_extract`, sound-plan engine, tech sub-slots on the same rails, review system, audio track uploads | <5-min link-in onboarding measured with 10 real performers; SMS slot post → confirmed booking demonstrated; tech books through a sub-slot; uploaded audio plays on a profile |
| **M3 — Launch hardening** (wk 12–14) | `media_fraud_screen`, `support_triage`, dispute flow + ops dashboard, liquidity dashboard, iCal, rate limits, backup-restore drill, load test at 100× | Ops can run a dispute start-to-finish; on-call runbook exists; Phase 0 anchor venues onboarded to staging |

Deliberately deferred (with their seams): replacement engine (consumes `cancelled_by_performer` events), split payouts (ledger rows already per-member), promotion generation (consumes `confirmed` events), POS integration (joins `venue_night_facts`), native apps (PWA until push becomes the binding constraint), ML ranking (pgvector columns waiting).

## 15. Open engineering questions

1. **ACH vs card default for venue charges** — ACH fees suit our margins (K3 processing spread) but the multi-day settlement stretches `confirming`; likely card-default at MVP, ACH for subscriptions later.
2. **Twilio A2P 10DLC registration lead time** — must start in M0 (weeks of carrier vetting; SMS is P0).
3. **Recurrence representation** — RRULE strings vs explicit occurrence materialization; leaning materialize-next-N-occurrences (simpler queries, explicit overrides) with the series as generator.
4. **Outreach system boundary** — the Phase 0 agentic outreach stack (see `research/agentic-outreach-wishlist.md`) stays a **separate deployable with its own DB**, integrating only via suppression-sync + signup-attribution APIs; prospects are not `users`. Confirm this boundary holds once a provider is chosen.
5. **Multi-performer slots (comedy lineups, P1)** — model as N bookings against one slot vs one booking with N parties; leaning N bookings (state independence per act) with a `lineup_id` grouping. Decide before M2 schema freeze.
