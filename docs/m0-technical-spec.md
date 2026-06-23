# M0 Technical Spec — Walking Skeleton (build-ready)

> **Note (June 2026):** this is the M0 historical record. For the launch payments posture it is **superseded by [`pricing.md`](pricing.md)** — payments are deferred and the launch is discovery-first (the venue pays the act directly). The seams below are correct; the launch defaults changed.

**Date:** June 2026. Implements milestone M0 from [`engineering-spec.md`](engineering-spec.md). This document is component-level and concrete: what exists, where it lives, exact states and routes. Scope: a venue can sign in, build a profile, post a slot; a performer can sign in, build a profile (bio, photos, YouTube/Vimeo embeds), browse the feed, apply; the venue can message/invite, offer; the performer accepts; terms are recorded (no payments in M0 — `NullPaymentGateway` auto-succeeds so the *full* state machine runs from day one; per [`pricing.md`](pricing.md) §4 the money path is now deferred *indefinitely*, until venue monetization, not just to M1); every change lands in `events`.

## 1. Repository layout (pnpm workspaces)

```
gigit/
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json / .env.example
├─ packages/
│  ├─ domain/           # pure TypeScript, zero I/O — the part that must be correct
│  │  └─ src/
│  │     ├─ ids.ts            # branded ID types + generators
│  │     ├─ booking/machine.ts# state machine: pure reducer + transition table
│  │     ├─ booking/states.ts # states, events, terms types
│  │     ├─ cancellation.ts   # fee schedule (pure)
│  │     ├─ soundplan.ts      # sound-plan engine v0 (pure)
│  │     └─ schemas.ts        # zod input schemas shared by web+worker
│  └─ db/               # drizzle schema, client, outbox, transition runner
│     └─ src/
│        ├─ schema.ts         # all tables (single source of DDL truth)
│        ├─ client.ts         # pg Pool + drizzle instance
│        ├─ events.ts         # appendEvent() — same-tx outbox write
│        ├─ transition.ts     # runBookingTransition(): lock row → domain reducer → persist + event, atomically
│        └─ seed.ts           # dev/demo seed
├─ apps/
│  ├─ web/               # Next.js App Router — UI + all API routes (webhooks land here later)
│  └─ worker/            # Node: outbox dispatcher + pg-boss scheduled jobs
├─ infra/cdk/            # CDK skeleton (App Runner + EC2 worker + RDS + S3/CloudFront) — wired in M1
└─ .github/workflows/ci.yml
```

Dependency rule (enforced by review, later by lint): `domain` imports nothing workspace-internal; `db` imports `domain`; apps import both. No app imports the other app.

## 2. Domain package

### 2.1 Booking state machine (full set from day one)

States: `offered → confirming → confirmed → awaiting_confirmation → released`, terminal/branch: `collapsed`, `disputed`, `cancelled_by_venue`, `cancelled_by_performer`, `refunded`, `partially_released`.

Events (commands): `PERFORMER_ACCEPTED`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `OFFER_EXPIRED`, `GIG_ENDED`, `PERFORMER_MARKED_PLAYED`, `VENUE_CONFIRMED`, `AUTO_CONFIRM_ELAPSED`, `DISPUTE_OPENED`, `DISPUTE_RESOLVED`, `VENUE_CANCELLED`, `PERFORMER_CANCELLED`.

The machine is a **pure reducer**: `decide(booking, event, clock) → { next, effects[] } | DomainError`. Effects are data (`{kind: "schedule", job, runAt}`, `{kind: "charge"}`, `{kind: "notify", template, to}`, `{kind: "reopen_slot"}`, `{kind: "fee", schedule}`) — the db layer persists them as event payload; the worker interprets them. M0 interprets `charge` via `NullPaymentGateway` (immediate `PAYMENT_SUCCEEDED`), logs `notify`.

Cancellation fees (pure function): >14d → 0%, 48h–14d → 50%, <48h → 100% of `terms.amount_cents`. **Per [`pricing.md`](pricing.md) §4 the monetary fee schedule is deferred (not "M1 moves money").** A cancellation reopens the slot, notifies, and applies a reliability strike at launch; the fee math stays built but dormant until venue monetization.

Tests: exhaustive table test (every state × every event → expected next or rejection) + scenario tests for the happy path, both cancellation branches at each fee window, offer expiry, dispute.

### 2.2 Sound-plan engine v0

`soundPlan(venuePA, performerNeeds) → {verdict, gaps[], inputList[]}` with `verdict ∈ covered | tech_needed | tech_and_rig_needed`. Rules v0: no PA + amplified needs → `tech_and_rig_needed`; PA but channels < inputs or no operator → `tech_needed`; else `covered`. Fixture tests. (Surfaces in UI at M2; lives in domain now because it's pure and cheap.)

## 3. Database (drizzle, Postgres 16)

Tables (M0): `users`, `auth_otps`, `actor_roles`, `performers`, `venues`, `techs`, `media_assets`, `slots`, `applications`, `bookings`, `threads`, `thread_participants`, `messages`, `events`. Deferred to their milestone: `ledger_entries`, `slot_series`, `tech_subslots`, `reviews`, `disputes`, `ai_tasks` (M1/M2 migrations). **Per [`pricing.md`](pricing.md): reviews + reliability are now CORE (stay on at launch); only the money tables (`ledger_entries`, the dispute *money-resolution* path) defer.**

Key decisions:
- IDs: text ULIDs generated in `domain/ids.ts` (sortable, no DB extension needed).
- Geo at M0: `lat/lng double precision` + haversine SQL for the feed radius filter. PostGIS arrives with real matching (M1+); schema change is additive.
- `bookings.version int` — optimistic lock; transition runner does `UPDATE … WHERE id=$1 AND version=$2`.
- `events` (append-only): `id bigserial, occurred_at, actor, kind, subject_type, subject_id, payload jsonb, dispatched_at`. **Outbox = `dispatched_at IS NULL`.** All transactional side-effects are event rows; the worker polls and dispatches (`FOR UPDATE SKIP LOCKED`, batch 50, 1s interval). pg-boss is used only for *scheduled* work (offer expiry, gig-end, auto-confirm timers), where post-commit enqueue is acceptable because the schedule is re-derivable from booking state (reconciler job re-arms missing timers every 10 min).
- `media_assets`: `kind image|audio|video_embed`; uploads carry `storage_key`; embeds carry `embed_url + embed_meta`. M0 ships **image upload + video_embed** (audio lands M2 per build plan). Storage driver interface: `local` (dev, `.data/uploads`) and `s3` (presigned POST) — selected by env.

## 4. Web app (Next.js 15, App Router)

### 4.1 Auth & session
- Passwordless OTP: `POST /api/auth/request` `{phone|email}` → creates `auth_otps` row (6-digit, 10-min TTL, 5 attempts); dev mode logs the code, prod sends via Twilio/SES (M1). `POST /api/auth/verify` → upserts `users`, sets session.
- Session: JWT (jose, HS256, `SESSION_SECRET`) in an httpOnly/secure/sameSite=lax cookie, 30-day TTL, `{userId}` only — roles re-read from DB per request (`requireUser()` / `requireRole(kind)` helpers).

### 4.2 API routes (route handlers; zod-validated; errors as `{error:{code,message}}`)

| Method & path | Auth | Action |
|---|---|---|
| POST `/api/auth/request`, `/api/auth/verify` | — | OTP flow |
| GET/PATCH `/api/me` | user | who am I + roles; update basics |
| POST `/api/performers` · PATCH `/api/performers/:id` · GET (public) | user/owner | create/edit performer profile (bio, genres, rates, travel radius, tech needs) |
| POST `/api/venues` · PATCH · GET | user/owner | venue profile incl. `pa_inventory`, lat/lng |
| POST `/api/techs` · PATCH · GET | user/owner | tech profile |
| POST `/api/media/presign` → POST `/api/media/:id/complete` | owner | image upload (quota-checked); complete flips `processing→ready` (screening hook stub) |
| POST `/api/media/embed` | owner | add YouTube/Vimeo URL (host allow-list, oEmbed fetch, cache meta) |
| POST `/api/slots` | venue | create slot (budget required) |
| GET `/api/slots?lat&lng&radius_km&format&date_from&min_budget` | performer | feed (open slots, haversine, filters) |
| GET `/api/slots/:id` | any | detail incl. venue room/PA summary |
| POST `/api/slots/:id/applications` | performer | one-tap apply (unique per slot+performer) |
| GET `/api/slots/:id/applications` | venue owner | applicant list w/ profiles |
| POST `/api/applications/:id/offer` | venue owner | locked terms `{amount_cents, set_times, provides}` → creates booking `offered`; 72h expiry timer |
| POST `/api/bookings/:id/accept` | performer | `PERFORMER_ACCEPTED` → confirming → (Null gateway) confirmed; both click-wrap acceptances recorded with template hash |
| POST `/api/bookings/:id/cancel` | either party | routes to the correct cancel event; fee computed + recorded |
| GET `/api/bookings?role=` | party | my bookings w/ state |
| POST `/api/threads` `{performer_id, slot_id?}` | venue | **inquiry thread** (per-venue daily cap) |
| GET `/api/threads` · GET/POST `/api/threads/:id/messages` | participant | messaging (thread scopes: inquiry/application/booking) |

### 4.3 Pages (server components, minimal styling, mobile-first)
`/` feed (role-aware) · `/slots/new` · `/slots/[id]` (detail + apply/applicants) · `/p/[id]` public performer EPK (bio, photos, embeds) · `/v/[id]` venue page · `/me` profile editor (per role, incl. media manager) · `/bookings` + `/bookings/[id]` (state, terms, agreement text, actions) · `/inbox` + `/inbox/[threadId]` · `/login`.

## 5. Worker

Single process, two loops + pg-boss:
1. **Outbox dispatcher:** poll `events` (`dispatched_at IS NULL`, `FOR UPDATE SKIP LOCKED`) → route by `kind` → M0 sinks: console/structured-log notifier (the seam where SMS/email lands in M1) → mark dispatched.
2. **pg-boss schedules:** `booking.offer_expiry`, `booking.gig_ended`, `booking.auto_confirm` — each handler calls `runBookingTransition()` (idempotent: stale-state job = no-op) — plus `timers.reconcile` every 10 min re-arming any missing timer from booking state.
3. Graceful shutdown (SIGTERM → drain), `/healthz` not needed (no inbound).

## 6. Config & env

`packages/db/src/env.ts` zod-validates: `DATABASE_URL`, `SESSION_SECRET` (≥32 chars), `APP_URL`, `STORAGE_DRIVER=local|s3`, (`S3_BUCKET`, `AWS_REGION` when s3), `NODE_ENV`. `.env.example` documents all. Fail-fast at boot.

## 7. Local dev & testing

- `docker compose up db` → Postgres 16 on 5433; `pnpm db:migrate` (drizzle-kit); `pnpm db:seed` (demo venue, 2 performers, tech, open slots); `pnpm dev` (web+worker concurrently).
- Tests: **domain** — vitest, no I/O, exhaustive machine tables; **db** — vitest against dockerized Postgres (transition runner: concurrency/version-conflict test, outbox atomicity test); **web** — route-handler tests for auth + the offer→accept happy path (vitest + test client against the dev DB).
- CI (`ci.yml`): pnpm install → typecheck all → domain tests → db+web tests with Postgres service container → build web.

## 8. M0 exit criteria (from engineering spec, made testable)

1. Seeded venue posts a slot via UI; seeded performer applies; venue opens inquiry + offers; performer accepts; booking reaches `confirmed` with agreement recorded — demonstrated end-to-end on a fresh `docker compose` environment.
2. `SELECT kind FROM events WHERE subject_id=:booking` tells the full story in order.
3. Domain test suite: every state×event cell covered; fee schedule property-checked at boundary times.
4. Kill the worker mid-flow → restart → timers re-armed by reconciler; no lost transitions.
