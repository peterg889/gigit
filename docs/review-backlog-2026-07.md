# Review backlog — July 2026

> **Status, 2026-07-30:** the correctness, auth, duplication and
> highest-impact design items below have been fixed — see git log for
> 2026-07-29/30. What remains is listed under **Still open** at the bottom;
> everything above it is kept as the record of what was found and why it
> mattered, since several fixes are only sensible in light of the original
> reasoning.

Output of a 13-dimension review. Everything below was **verified against the
code**, not guessed. Items already fixed are in git log for 2026‑07‑29; this file
is only what's left, ranked within each section.

## Correctness — fix before beta invites

1. **`reconcileLoop` cannot be tested and now carries the payment-timeout
   rescue.** `apps/worker/src/index.ts:535` is a private `while (!stopping)` with
   a 10-minute sleep; `drainOutboxOnce` is the file's only export. So the 24h
   `confirming` unwedge, the timer re-arm safety net, and the alarm thresholds
   have no test. Note the rescue skips rows with `performer_accepted_at IS NULL`
   — the exact state it exists to drain. Export a `reconcileOnce()` and seed the
   four cases (25h-old `confirming`, 1h-old, NULL-accepted, `awaiting_confirmation`
   25h past `endsAt`).
2. **OTP attempt counter is racy and the cap test bypasses it.**
   `api/auth/verify/route.ts:31` does `attempts: otp.attempts + 1` — a
   read-modify-write off an unlocked SELECT, no row lock, no `sql\`attempts + 1\``.
   There's no rate limit on verify (only on request). The cap test seeds
   `{attempts: 5}` directly, so the increment path never reaches the cap.
3. **`authVerifySchema` lacks the phone-xor-email refine its sibling has**
   (`packages/domain/src/schemas.ts:215` vs `:211`), and `phone` is a bare
   `z.string()`. `{phone: <mine, with a valid code>, email: <victim's>}` reaches
   the insert and creates a user row carrying the victim's email.
4. **The CSPRNG for login codes never executes in any test.**
   `api/auth/request/route.ts:61` uses `randomInt` only when
   `NODE_ENV === "production"`, else the literal `"000000"`. Both request-route
   tests 503 at the channel gate 26 lines earlier. Swap the ternary branches and
   production issues `000000` to everyone, suite green.
5. **Slots never expire.** No producer for `slots.status = 'expired'`, so
   `/slots/[id]` renders an apply form for a gig whose date has passed, and the
   admin fill-rate denominator counts every dead past slot forever.
6. **`TERMINAL_STATES` is hardcoded in four places and they disagree about
   whether `released` is terminal** — `transition.ts:119`, `series.ts:55`,
   `slots/[id]/route.ts:105`, `reconcile.ts:34`. Import the domain constant.
7. **`AUTO_CONFIRM_HOURS = 24` exists in six places**, five of them prose in
   notification bodies, and the reducer's copy is not exported. Shorten it and
   money releases hours before both parties were told. The fix pattern already
   exists two files over (`review_prompt` interpolates `REVIEW_VISIBILITY_DAYS`).
8. **No unique index on any `ownerUserId`.** "One profile per user" is enforced
   by check-then-insert in three routes; `performerOwnedBy` returns `rows[0]`
   with no ordering. Two concurrent POSTs both pass, and thereafter *which*
   profile you own is nondeterministic per request.
9. **Sub-slot reopen cleanup sits outside its transaction**
   (`api/tech-subslots/[id]/cancel/route.ts:41`), unlike the booking equivalent.
   A crash in the window leaves the subslot `open` with stale `declined` rows,
   and `onConflictDoNothing` then 409s that tech forever.
10. **The admin adjustment is not idempotent and is invisible to both balance
    checks.** `idempotencyKey` includes `Date.now()`, the route isn't
    transactional, and `adjustment` appears in neither `bookingLedger`'s sums nor
    `reconcile.ts` — the one entry type a human types a free-form number into.
11. **`deactivateAccount` winds down performer and venue commitments but not
    tech** (`packages/db/src/account.ts:87`). A tech who leaves keeps booked
    sub-slots with money charged and nobody notified.

## Tests

- **39 of 62 API routes have no test file; all 30 `page.tsx` have zero.** The
  ~500 count is inflated: ~300 come from two exhaustive state×event tables.
- **Tests that cannot fail:** `ai.eval.test.ts:92` (`expect(true).toBe(true)`,
  and the whole golden set including the prompt-injection corpus is
  `describe.skip` in CI because no `GEMINI_API_KEY` is set);
  `ledger.test.ts:89` (asserts a literal it just asserted `toEqual` against —
  the file calls it "THE money invariant"); `postgig.test.ts:136` (titled
  "either party… strangers cannot", tests only one party);
  `support/route.test.ts:93` (seeds 100 rows into a table the quota doesn't
  read); `stripe/route.signature.test.ts` (both cases 400 for the same
  environmental reason; no valid signature is ever accepted anywhere).
- **Every money literal in the suite is a whole dollar.**
  `cancellation.ts:23`'s `Math.round(amountCents / 2)` — the only percentage
  split in the product — has no test file. Conservation holds today only because
  the second leg is derived by subtraction.
- **Fall-back DST is untested everywhere** (spring-forward is well covered).
  `zonedDateTimeToDate` has no defined behavior for a wall time that occurs
  twice, and a flip to the second instant breaks `materializeSeries`
  idempotency. Both `series.test.ts` cases use the legacy `startTimeUtc` shape,
  so the venue-local branch never runs against the DB.
- **All 30 hand-rolled venue fixtures omit `timeZone`**, so every suite venue is
  UTC and `venueLocationIsComplete` is false for all of them — which is *why*
  the venue-local scheduling code is untested. One `makeVenue()` factory would
  surface most of the DST gaps for free.
- **`apps/web/vitest.config.ts` has neither `globalSetup` nor
  `fileParallelism: false`**, so `--workspace-concurrency=1` in the root script
  is load-bearing. Nothing truncates between runs; `founding.test.ts` and
  `ratelimit.test.ts` are already non-idempotent against a persistent database.
- **`booking-journey.spec.ts` re-inlines all five `e2e/helpers.ts` functions
  verbatim** — the helper was extracted from it and it was never migrated. The
  e2e specs also pin `.card`/`.badge`/`.money` class names ~20 times, so a
  stylesheet rename silently returns zero matches in the suite that gates the
  staging deploy.

## Product — highest value next

1. **A booking-scoped thread.** `threads.scope` supports `'booking'`; only
   `'inquiry'` is ever written, and a performer cannot initiate a thread to a
   venue *even one they have a confirmed booking with*. `/help` already promises
   "agree in the booking thread." Today, the moment a deal confirms, the product
   hands both sides each other's phone number and offers no on-platform
   channel — with no escrow, an on-platform record of *changes* to the deal is
   the only substitute EightGig has for money in the middle.
2. **Structured invite-to-slot.** Two shipped notification templates
   (`new_act`, `slot_quiet`) tell venues to "send an invite." No invite endpoint
   exists; the only action is a free-text DM whose own placeholder pushes terms
   into unstructured chat. Both cold-start nudges dead-end here.
3. **Make rooms discoverable to acts.** `/v/[id]` is linked from exactly one
   place — the venue's own "view public page." No `/venues` directory, and slot
   cards link the venue name to the slot. So performer→venue reviews, the
   brand's flagship symmetric-accountability claim, are published where no act
   can read them. An act's day one is an empty feed and nothing else.
4. **Sound-plan defaults cry wolf on every gig.** Venue `hasOperator` defaults
   `false` and performer `inputs`/`mics`/`monitors` default `0`, so a
   default-configured booking returns `tech_needed` with the sole gap "no one to
   run sound" — for a metro with no seeded techs. The plan is also never
   computed at slot creation, never shown pre-application, and not persisted.
   Make those fields required with no default and add an `unknown` verdict.
5. **Rebook only works inside a series** (`series.ts:52` requires
   `series_id is not null`). A venue that posted a one-off and loved the act has
   no rebook path at all — and the one-off venue is the majority at launch.

Half-built, should be finished or removed: iCal export (complete API, zero UI
entry points); distance and `min_budget_cents` filters on `GET /api/slots`
(tested, no callers); `ai_tasks` (written on every AI call, read by nothing —
it's the evidence for "AI drafts, humans confirm"); tech-authored reviews
(collected, no reader); `refunded` bookings permanently unreviewable despite the
gig having happened; the AI profile-ingest widget renders only on `/me`, off the
signup funnel entirely.

`docs/prd-coverage.md` header claims all 14 gaps closed while its own tables
still mark four as ❌ — actively misleading; rewrite or delete.

**Biggest product risk:** the commit path has no reliable route to the other
person's attention. `notifyUser` sends over exactly one channel — SMS if
present, else email, never both — a Twilio 4xx is swallowed with no fallback,
there is no in-app attention surface of any kind (no unread count, no "needs
your response" list), and both channels ship empty in CDK so a fresh deploy
sends everything to `notify.log_sink` until an operator hand-edits Secrets
Manager. Venue offers, act never sees it, offer expires, venue concludes acts
are flaky.

## Design

The aesthetic lane is genuinely delivered — condensed poster display type,
kraft-and-ink palette, 2–3px radii, grain, one warm stage light. Text contrast
passes throughout (muted 6.18:1, amber 10.65:1). The problems are hierarchy and
non-text contrast.

1. **`ApiForm` uses the field name as the DOM id**, so any page with two forms
   sharing a field name emits duplicate ids and `<label for>` binds to the
   first. `/slots/new` has five duplicates on one screen — tapping "Duration"
   under *Make it a series* focuses the single-date form's field. `/me` has
   `id="name"` ×3. The directory pages render up to 100 elements with
   `id="body"`. Use `useId()`; `SupportForm.tsx:57` is the in-repo reference.
2. **Form fields are effectively invisible.** `--line` on `--room` is **1.54:1**
   against a 3:1 requirement, and the input fill is 1.11:1 against the card.
   The Budget field's dim placeholder also reads as an entered value — on the
   one field the brand says must never be blank. Add a `--line-strong` ≥3:1.
   Related: `input:focus` sets `outline: none` and out-specifies
   `:focus-visible`, so fields get a ~1.5:1 1px indicator while everything else
   gets a 3px ring.
3. **Every date shows the year and hides the weekday.** `dateStyle: "medium"`
   yields "Aug 31, 2026, 6:00 PM". For a bar gig the weekday *is* the decision;
   brand.md's own voice samples lead with it and never print the year.
4. **The nav eats four rows of ~20px tap targets** — ~110px of a 390px phone
   before any content, with no current-page indicator and `:hover` as its only
   state. Buttons are ~38px, filter chips ~29px, the `/inbox` badge-link ~17px.
5. **`/inbox` shows no counterparty and no preview** — a dozen identical rows
   reading `ACT INQUIRY  Jul 22, 2026`. The data is already resolved one file
   over in `inbox/[id]/page.tsx`.
6. **Ten unassociated `<label>`s in the AI review widgets** (`AiAssist.tsx`,
   `MediaManager.tsx`) — precisely the forms where a human is supposed to verify
   AI output. And no `aria-live` on any of the seven components that produce
   every error in the product.
7. **Label-map drift regressed the thing `labels.ts` exists to prevent:** four
   copies of the act-kind map ("Other act" vs "Other"), three of the format map
   ("Live music" vs "Music" — so a venue picks "Music", the AI preview badges
   "MUSIC", and the feed card badges "LIVE MUSIC"), two hardcoded sound-verdict
   vocabularies, two gear maps.
8. **Message timestamps render in server time** — `inbox/[id]/page.tsx:76` calls
   `toLocaleString` with no `timeZone` in a server component, so an 8pm Central
   message shows as 1:00 AM. Same bypass in four other places.
9. **The type scale has no middle**: a 2.5× cliff from h1 to h2, then eight
   sizes inside a 10px band. `h3` has no size at all and falls to ~18px,
   *smaller* than `h2`.
10. **The bad path has the weakest treatment in the product.** `.notice` has no
    warn/danger variant, so cancellation and dispute copy is inline 14px
    `.muted` — against brand.md §5.5. `.badge` likewise can't express valence,
    so "Cancelled by venue" and "3 cancellations" render in the money amber.
    `performerReliability` already returns a `tier`; every call site discards it.

## Duplication

`openSlotFeed()` is the one worth doing: `slots/page.tsx:42` and
`api/slots/route.ts:62` are the same query, and they have **already drifted** —
the API never got the `either`-wildcard fix and doesn't normalize metro, so
`GET /api/slots?format=music` hides every music-or-comedy night the page shows
and `?metro=Milwaukee` returns `[]`. Same metro bug in
`api/performers/search`. After that: `loadSubslotForActor()` (the sub-slot party
predicate is duplicated 4× — it's an authorization predicate), and the 12-line
booking-load preamble that is byte-identical in three routes.

Keep separate, deliberately: the two state machines (`machine.ts` vs
`subslot.ts` — genuinely different, and they already share
`venueCancellationFee`); the two effect vocabularies; the notification override
layer; media handling (already generic). `setProfileVisibility` is the pattern
the profile CRUD trio should copy.

Dead code worth deleting: `SUBSLOT_TERMINAL`, `resetGateway`,
`venueLocalInputValue`, 13 unreferenced branded-ID aliases, three `void db()`
no-ops, and `bookingLedger` (zero production callers — while `reconcileMoney`,
the invariant that actually runs, has one seeded scenario).

---

## Still open

Updated 2026-07-30, after the sweep. Everything previously listed here is done
except the following. Nothing here is a live functional bug.

### Tests

- **`reconcileMoney()` has one seeded scenario.** Now that `adjustment` is in
  scope for the balance check, add a clean-check per terminal path plus a case
  whose only imbalance is an adjustment.
- **Three remaining tests that can't fail:** `postgig.test.ts:136` is titled
  "either party… strangers cannot" and tests only one party;
  `support/route.test.ts:93` seeds 100 rows into a table the quota query doesn't
  read; and no test anywhere accepts a *valid* Stripe or Twilio signature — both
  signature suites pass for the same environmental reason (no keys configured),
  so breaking the payload construction would 403 every real webhook and every
  inbound STOP with the suite green. The health route's 503 branch is also
  untested, and that endpoint is the ALB target check and the staging deploy gate.
- **e2e still pins `.card`/`.badge`/`.money` class names ~20 times**, so a
  stylesheet rename silently returns zero matches in the suite that gates the
  staging deploy. (`booking-journey.spec.ts` is now on the shared helpers, which
  removes the duplicate copies but not the coupling.)

### Cleanup

- The 12-line booking-load preamble (booking + dual-profile resolution) is
  byte-identical in `bookings/[id]/{cancel,dispute,tech-subslot}` — the same
  treatment `loadSubslotForActor()` just got for sound jobs.

### Product, deliberately not built

Judged not worth it now, recorded so the reasoning isn't lost: two-way calendar
sync (iCal-out has no UI entry point yet), review dimensions, read receipts,
notification preferences, PWA push (make SMS+email reliable first), badges,
lineups (`bookings_active_slot_uq` forecloses it and it shouldn't be reopened
before liquidity), and POS/ROI (F8.5 — `venue_night_facts` stores no revenue yet,
so there is nothing to join against, and ranking acts by revenue lift is one step
from pay-to-rank by proxy).

Metro canonicalization is real but a month-three problem: at ~25 hand-signed
anchor venues the founder is typing the metro strings.

### Yours

- **`GEMINI_API_KEY`** — empty in prod. The three AI-assist routes now degrade to
  the manual form instead of showing a variable name, so this is a missing
  feature rather than a broken one.
- **`SENTRY_DSN`** — empty. CloudWatch now alarms on outbox lag, dead letters and
  money mismatches independently, so this is narrative error detail, not paging.
- **DMCA agent registration** (~$6, needs a real postal address). The procedure is
  published; the statutory designation isn't, and §512 eligibility doesn't backdate.
- **Governing law** — set to Wisconsin / Milwaukee County on the assumption the
  entity is organized there.
- **`eightgig.com` mailbox** (Workspace + SPF/DKIM/DMARC + warmup), still blocking
  Reachout sending. **CAN-SPAM postal address** for that tenant.
- **Domain registration transfer** — window opens ~Sept 14.
- **Two OpsAlerts subscription confirmations**, without which none of the alarms
  above reach a human.
- Optional: create the GitHub `production` environment with yourself as required
  reviewer, then set `PROD_DEPLOY_ENABLED=true`. That turns promotion into a
  one-click approval. I left it unset because the workflow claims a reviewer gate
  that does not exist, so enabling it today would make every merge deploy to prod.
