# Testing strategy & coverage map

**Date:** June 2026. Implements engineering-spec §13 and audits it against the code. The principle, restated: **the defects that kill this product are state-machine and money defects** — so correctness effort concentrates there, in layers: pure exhaustive tests → property tests → integration against real Postgres → one E2E pass through the live stack → nightly reconciliation in production as the last tester.

## The layers

| Layer | What it proves | Where | Runs |
|---|---|---|---|
| 1. Pure domain | every rule, exhaustively | `packages/domain/src/**/*.test.ts` | every `pnpm test`, CI |
| 2. Property/model | invariants on paths nobody enumerated | `machine.property.test.ts` (fast-check, 1,500 random sequences) | every `pnpm test`, CI |
| 3. DB integration | transactions, locking, ledger, SQL | `packages/db/src/*.test.ts` against real Postgres | every `pnpm test`, CI |
| 4. Route/unit | web logic outside the happy path | `apps/web/src/**/*.test.ts`, `apps/worker/src/*.test.ts` | every `pnpm test`, CI |
| 5. E2E | the journeys, through the real stack | `e2e/*.spec.ts` (Playwright) | `pnpm e2e`; CI `e2e` job (web+worker+pg) |
| 6. AI golden set | task output properties + injection corpus | `ai.eval.test.ts` | CI **only when `GEMINI_API_KEY` secret is set** |
| 7. Production | the tests we can't write: external drift | nightly `reconcileMoney` + outbox-lag paging | every night, pages on failure |

## Coverage map (what each risk is covered by)

| Risk | Covered by |
|---|---|
| Illegal booking transition | exhaustive state×event table (every cell) + property tests |
| Money mis-split on cancellation | fee-window cases at boundaries + property test (`fee+refund == amount` on every random path) + sub-slot integration |
| Double charge / double release | ledger idempotency tests + runner version-conflict test + sub-slot re-transition test |
| Re-booked sub-slot swallowing its charge | `subslots.test.ts` money-conservation case (this test caught the real bug; fixed with version-keyed idempotency) |
| Reconciliation missing a fault | `reconcile.test.ts` seeds an unbalanced terminal booking and an orphan settlement; asserts exactly those are flagged (M1 exit criterion) |
| Timer loss on worker crash | reconciler re-derivation (transition.test lifecycle + M0 exit criterion 4) |
| Recurrence drift | pure occurrence tests (weekly, Nth-weekday, last-weekday, boundary) + materializer idempotency integration |
| Sound-plan wrong verdict | fixture tests (v0 rules; grow toward the 50-fixture library with real venue data) |
| Media smuggling (wrong bytes) | `sniffKind` unit tests: every signature + HTML/text/empty rejections; live path verified manually (fake PNG → rejected) |
| Review leaks before double-blind | `visibleReviews` pure tests incl. the exactly-7-days boundary |
| SMS compliance (STOP before logic) | router tests: STOP/START/HELP, unknown number, parse degradation, TwiML escaping |
| Saved-search false negatives | `matchSavedSearches` integration: format/metro/budget filters + the `either` rule |
| Night-facts gaps (unbackfillable) | snapshot integration: gig night, quiet night, idempotency |
| AI output breaking schema | zod validation at the gateway (parse failure = task failure) + golden evals |
| Prompt injection steering tasks | injection corpus in evals (key-gated) + fenced-data convention |
| The whole thing actually working | E2E: post → apply → offer → accept → worker-confirmed, two real browser sessions |

## How to run

```bash
pnpm test          # layers 1–4 (domain, property, db-integration, route/unit)
pnpm e2e           # layer 5 — needs the dev stack up (pnpm dev) and seeded db
GEMINI_API_KEY=… pnpm --filter @gigit/db test   # layer 6 evals locally
```

CI runs layers 1–4 in `build-test`, layer 5 in the `e2e` job (own Postgres + web + worker), and layer 6 automatically once the `GEMINI_API_KEY` secret is added to the repo.

## Known gaps — open and owned

1. **Stripe test-mode integration** (spec §13 "Payments"). The Null gateway proves the machine; it cannot prove Stripe. Blocked on test keys. When available: run the full lifecycle (SetupIntent capture → charge → webhook → release → refund, both cancel branches) against Stripe test mode and add it as a key-gated CI suite like the AI evals. **This is the highest-risk untested code in the repo.**
2. **E2E breadth**: 1 of the 5 spec journeys is automated (the core booking). Remaining, in priority order: tech attach (rails exist, journey pending), cancel-with-fees, review round-trip, SMS slot post (also gated on A2P + a Gemini key). The harness and pattern now exist — each is an afternoon, not a project.
3. **Sound-plan fixture library**: ~5 cases vs the spec's ~50 "real venue/performer combos with expert-asserted verdicts." Grows with Phase 0 venue onboarding — every real `pa_inventory` captured becomes a fixture.
4. **Worker dispatch loop**: effect-routing is exercised indirectly (integration + E2E through the live worker) but has no isolated harness; pg-boss scheduling behavior is trusted. Acceptable at this scale; revisit if dispatch bugs appear.
5. **Load**: `scripts/loadtest.mjs` exists; meaningful numbers require the staging deploy (dev-server latencies are noise).
6. **Accessibility (WCAG 2.1 AA)**: no automated checks; add axe-core to the E2E pass when the design settles.

## Conventions

- Tests live next to the code they test; integration tests create their own rows with fresh ULIDs (no shared fixtures, no cleanup dependencies — the dev/CI database accretes test rows by design).
- Every bug found in production or by reconciliation gets a regression test at the LOWEST layer that can express it.
- Clock-dependent logic takes an injected `now` — no test ever sleeps to make time pass.
- AI tests assert properties, never exact text.
- **Live-model evals sample, they don't single-shot.** Adversarial/injection evals run the prompt N times and require the safe behavior in a supermajority (≥4/5) — a single live sample is noise and would flake CI. A thrown/rejected gateway call counts as a *safe refusal* (the schema validator did its job). The functional evals (brunch parse, KB-grounded answer) are single-sample today because the model is consistent on them; harden them the same way if they ever flake.
