# Testing strategy & coverage map

**Date:** July 2026. Implements engineering-spec §13 and audits it against the code. The principle, restated: **the defects that kill this product are state-machine and LIQUIDITY/HANDSHAKE defects** — so correctness effort concentrates there, in layers: pure exhaustive tests → property tests → integration against real Postgres → six currently passing E2E specs through the production stack → nightly reconciliation in production as the last tester.

At the discovery-first launch EightGig processes no gig money (`NullGateway`, `PAYMENTS_ENABLED` false — see [`pricing.md`](pricing.md) §4), so the load-bearing launch risk is **liquidity and handshake correctness** (does the feed surface the right slots, does apply→offer→accept hold, do reviews/reliability behave) — not money. The money-path coverage below is real and stays green against the dormant code, but it tests a **deferred path**: nightly reconciliation-in-production is a deferred-path tester that only runs when `PAYMENTS_ENABLED`, and the money-risk rows are re-tiered accordingly.

## The layers

| Layer | What it proves | Where | Runs |
|---|---|---|---|
| 1. Pure domain | every rule, exhaustively | `packages/domain/src/**/*.test.ts` | every `pnpm test`, CI |
| 2. Property/model | invariants on paths nobody enumerated | `machine.property.test.ts` (fast-check, 1,500 random sequences) | every `pnpm test`, CI |
| 3. DB integration | transactions, locking, ledger, SQL | `packages/db/src/*.test.ts` against real Postgres | every `pnpm test`, CI (the **ledger** integration is *deferred-path* — exercises dormant money code; runs when `PAYMENTS_ENABLED`) |
| 4. Route/unit | web logic outside the happy path | `apps/web/src/**/*.test.ts`, `apps/worker/src/*.test.ts` | every `pnpm test`, CI |
| 5. E2E | six currently passing browser specs through production builds of the real stack | `e2e/*.spec.ts` (Playwright) | `pnpm e2e`; CI `e2e` job (web+worker+isolated pg) |
| 6. AI golden set | task output properties + injection corpus | `ai.eval.test.ts` | local when `GEMINI_API_KEY` is exported; CI secret mapping is still open (QA-07) |
| 7. Production | the tests we can't write: external drift | nightly `reconcileMoney` (*deferred-path — runs when `PAYMENTS_ENABLED`; dormant at launch*) + outbox-lag paging | outbox-lag every night; `reconcileMoney` once payments are on; pages on failure |

## Coverage map (what each risk is covered by)

**Launch-critical** (discovery & handshake — these are the rows the discovery-first launch lives or dies on):

| Risk | Covered by |
|---|---|
| Illegal booking transition | exhaustive state×event table (every cell) + property tests |
| Saved-search false negatives | `matchSavedSearches` integration: format/metro/budget filters + the `either` rule |
| Feed surfacing wrong/leaked slots | feed/filter correctness + anti-leakage (only the right slots reach the right side) — exercised in integration + the E2E handshake pass |
| Review leaks before double-blind | `visibleReviews` pure tests incl. the exactly-7-days boundary |
| Recurrence drift | pure occurrence tests (weekly, Nth-weekday, last-weekday, boundary) + materializer idempotency integration |
| Sound-plan wrong verdict | fixture tests (v0 rules; grow toward the 50-fixture library with real venue data) |
| Tech sub-slot attach (handshake, not money) | `subslots.test.ts` attach/swap transitions + the automated E2E tech-attach journey |
| Timer loss on worker crash | reconciler re-derivation (transition.test lifecycle + M0 exit criterion 4) |
| Media smuggling (wrong bytes) | `sniffKind` unit tests: every signature + HTML/text/empty rejections; live path verified manually (fake PNG → rejected) |
| SMS compliance (STOP before logic) | router tests: STOP/START/HELP, unknown number, parse degradation, TwiML escaping |
| Night-facts gaps (unbackfillable) | snapshot integration: gig night, quiet night, idempotency |
| AI output breaking schema | zod validation at the gateway (parse failure = task failure) + golden evals |
| Prompt injection steering tasks | injection corpus in evals (key-gated) + fenced-data convention |
| The whole thing actually working | E2E: web post → apply → booking conversation → offer acceptance → worker-confirmed → rebook; direct invite → decline → reapply → re-offer; sound-job post → tech apply → tech booked; post-gig dispute → admin resolution → both reviews; past open date → worker expiry → discovery removal → stale apply/offer/invite rejection; staff suspension → commitment wind-down → discovery removal → owner deactivation; and direct no-commitment deactivation → signed-out session → durable deleted state, using separate browser sessions |

**Deferred-path** (money — covered and green against the dormant code, but only *runs* in prod when payments turn on; not a launch-blocking risk):

| Risk | Covered by |
|---|---|
| Money mis-split on cancellation | fee-window cases at boundaries + property test (`fee+refund == amount` on every random path) + sub-slot integration |
| Double charge / double release | ledger idempotency tests + runner version-conflict test + sub-slot re-transition test |
| Re-booked sub-slot swallowing its charge | `subslots.test.ts` money-conservation case (this test caught the real bug; fixed with version-keyed idempotency) |
| Reconciliation missing a fault | `reconcile.test.ts` seeds an unbalanced terminal booking and an orphan settlement; asserts exactly those are flagged (M1 exit criterion) |

## How to run

```bash
pnpm test          # layers 1–4 (domain, property, db-integration, route/unit)
pnpm e2e           # layer 5 — creates its DB, builds, starts, waits, and cleans up
GEMINI_API_KEY=… pnpm --filter @gigit/db test   # layer 6 evals locally
```

`pnpm e2e` owns the local application and database lifecycle. Playwright starts the
managed E2E server, which uses the server and credentials from `DATABASE_URL` to
create a uniquely named `gigit_e2e_*` database. The supervisor migrates it,
compiles the workspace packages, seeds the browser identities, builds the
production web and worker artifacts against that ready database, and waits for
the worker startup marker and database-aware web health endpoint.

After the managed child processes stop—whether the run succeeds, startup fails, or
the supervisor receives `SIGINT`/`SIGTERM`—the database is force-dropped. The
`DATABASE_URL` role must be able to connect to the standard `postgres` database
and have `CREATE DATABASE`; because it creates the temporary database, it also
owns and can drop it. The existing database named in `DATABASE_URL` is not
migrated, seeded, or otherwise modified. Only a reachable PostgreSQL server is
required; no manual `pnpm db:migrate`, `pnpm db:seed`, or `pnpm dev` is needed.

To run the same browser journeys against an already-running environment, set an
external base URL. Leading and trailing whitespace and trailing slashes are
normalized by the Playwright config:

```bash
E2E_BASE_URL="http://127.0.0.1:3002/" pnpm e2e
```

When `E2E_BASE_URL` is set, Playwright does not build, start, or stop a local
stack and does not create, migrate, seed, or drop a database. The target must
already contain the fixture identities from `packages/db/src/seed-fixtures.ts`
and accept the fixed `000000` test OTP (or provide an equivalent automated test
auth mechanism). An ordinary production-mode staging environment generates
random, delivered OTPs and is not compatible with these unattended specs yet.

CI leaves `E2E_BASE_URL` unset, gives the E2E job its own Postgres server, and
lets the managed supervisor own a temporary database plus the production-build
web and worker processes. Layers 1–4 run in `build-test`. Layer 6 currently
reports its tested skip reason in CI because the workflow does not map
`GEMINI_API_KEY` into a job; adding a repository secret alone does not inject it.
QA-07 tracks the explicit key-gated evaluation job.

## Known gaps — open and owned

1. **Stripe test-mode integration** (spec §13 "Payments"). The Null gateway proves the machine; it cannot prove Stripe. Blocked on test keys. When available: run the full lifecycle (SetupIntent capture → charge → webhook → release → refund, both cancel branches) against Stripe test mode and add it as a key-gated CI suite like the AI evals. **This is deferred-path code, not the highest launch risk** — at the discovery-first launch payments are off (`NullGateway`, `PAYMENTS_ENABLED` false), so this gap blocks no launch journey; the highest launch risk is discovery/liquidity correctness (feed, saved-search, the apply→offer→accept handshake, reviews/reliability). This path gets tested when payments turn on in Phase 2.
2. **E2E breadth**: Six Playwright specs automate seven permanent journeys: core web-post/apply/offer/accept, declined-offer recovery, sound-tech attach with cross-booking overlap rejection, post-gig dispute/resolution/double-blind review, aged-slot expiry and action rejection, staff-suspension/owner-deactivation, and direct no-commitment deactivation. Relative to the five critical paths in the engineering spec, SMS slot posting, payment-enabled accept/pay, and cancel-with-fees still lack browser coverage; web posting, the launch-mode core booking, completed-gig review, aged-slot behavior, and both account-deactivation paths are covered. SMS remains gated on A2P plus a Gemini key.
3. **Sound-plan fixture library**: ~5 cases vs the spec's ~50 "real venue/performer combos with expert-asserted verdicts." Grows with Phase 0 venue onboarding — every real `pa_inventory` captured becomes a fixture.
4. **Worker dispatch loop**: effect-routing is exercised indirectly (integration + E2E through the live worker) but has no isolated harness; pg-boss scheduling behavior is trusted. Acceptable at this scale; revisit if dispatch bugs appear.
5. **Load**: `scripts/loadtest.mjs` exists; meaningful numbers require the staging deploy (dev-server latencies are noise).
6. **Accessibility (WCAG 2.1 AA)**: no automated checks; add axe-core to the E2E pass when the design settles.
7. **Gemini evaluation CI wiring**: the tests clearly skip when `GEMINI_API_KEY` is absent, but the workflow does not yet map a repository secret into an evaluation job. Add an explicit key-gated job and cover both present/absent configuration paths (QA-07).

## Conventions

- Tests live next to the code they test; integration tests create their own rows with fresh ULIDs, so their shared dev/CI database can accrete rows. Playwright instead creates and drops a fresh database per managed run, so separate runs never inherit browser-test state. Parallel browser journeys use distinct seeded identities; retries share their run's database and therefore either use retry-specific markers or resume a dedicated fixture from its durable state.
- Every bug found in production or by reconciliation gets a regression test at the LOWEST layer that can express it.
- Clock-dependent logic takes an injected `now` — no test ever sleeps to make time pass.
- AI tests assert properties, never exact text.
- **Live-model evals sample, they don't single-shot.** Adversarial/injection evals run the prompt N times and require the safe behavior in a supermajority (≥4/5) — a single live sample is noise and would flake CI. A thrown/rejected gateway call counts as a *safe refusal* (the schema validator did its job). The functional evals (brunch parse, KB-grounded answer) are single-sample today because the model is consistent on them; harden them the same way if they ever flake.
