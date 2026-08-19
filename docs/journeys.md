# Journey map & coverage — the actor-oriented view

**Date:** August 2026. Derived from the code on `main`, not from the PRD. Every journey below is an
**actor pursuing an outcome end to end** — "a venue posts an open date and someone plays it" is a
journey; `GET /api/slots` is a route. Where a journey crosses six layers, all six are cited.

This is the third view of the same system, and it is deliberately the one that reads across
components:

| Doc | Organised by | Answers |
|---|---|---|
| [`testing.md`](testing.md) | **risk** | what could kill the product, and which layer defends it |
| [`technical-design.md`](technical-design.md) | **feature/component** | what each component is and what it promises |
| **this doc** | **actor** | what a person is trying to do, and whether a regression on that path fails anything |

Read `testing.md` first for the layering model (pure → property → DB-integration → route → E2E →
evals → production) and for the launch-risk framing — **liquidity and handshake correctness, not
money**. Read `technical-design.md` §4 for what each component owes. This document does not restate
either; it walks the paths a human takes across them and asks a single question at every step:

> **If someone deleted this line, would a test fail today?**

Frequently the answer is no even where a test file exists. Those cases are named, not glossed.

## Provenance — which parts had two passes and which had one

Enumeration ran in two sittings and the first was interrupted mid-run.

- **Sound tech, admin/ops and cross-cutting journeys** were enumerated, then coverage-mapped in a
  separate verification pass that opened the test files and checked whether the cited assertions can
  actually fail. Those coverage lines are the more trustworthy ones.
- **Act and venue journeys** were enumerated after the interruption and mapped in the same pass.
  They had **one pass, not two**. The citations are real and were read from source, but they have
  not been through the adversarial "can this test fail?" re-read that the tech/ops set got. Treat
  act/venue verdicts as slightly optimistic: where a tech journey says *partial*, the same shape on
  the act side may well be *partial* too and simply has not been squeezed as hard yet.

Anyone extending this doc should re-verify act/venue coverage first — that is where the remaining
false positives will be.

## Three facts that change what is true here

1. **EightGig hosts no user media.** Photos, tracks and video are *links* to allow-listed third
   parties (Flickr, Imgur, SoundCloud, Bandcamp, YouTube, Vimeo). There is no upload journey, no
   bucket, no sniffing, no virus scan — those were requirements of holding a file
   (`technical-design.md` §3.6/§4.5). Anything in an older doc about upload paths is stale.
2. **Payments are off.** `PAYMENTS_ENABLED=false` and no Stripe key, so `paymentGateway()` is the
   Null implementation and **no money moves**. Five journeys here are marked **DORMANT**. Their
   tests are green, deep and real — and they exercise a rail that cannot fire. *Do not spend gap
   budget there.* See `pricing.md` §4 and `testing.md`'s deferred-path table.
3. **Media links are moderated.** A pasted link lands `held`, an AI screen either flips it to
   `ready` or leaves it `held` with a fraud flag for ops, and ops can `block` it. Only `ready` is
   supposed to be public. That invariant is the subject of gap **G1**, and it is asserted nowhere.

---

## Summary

71 journeys across six actors.

| Actor | Journeys | Core | Important | Peripheral | Dormant | Covered | Partial | Uncovered |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Act | 14 | 7 | 7 | — | — | 6 | 8 | — |
| Venue | 17 | 7 | 10 | — | — | 8 | 9 | — |
| Sound tech | 10 | 2 | 6 | 1 | 1 | — | 9 | — |
| Admin / ops | 20 | 5 | 12 | 1 | 2 | 7 | 10 | 1 |
| Cross-cutting (any signed-in) | 8 | 2 | 4 | 1 | 1 | 2 | 5 | — |
| Anonymous | 2 | 1 | — | — | 1 | 1 | — | 1 |
| **Total** | **71** | **24** | **39** | **3** | **5** | **24** | **41** | **1** |

Read that table with one qualification: **24 "covered" means 24 journeys where a regression on the
main path fails something today** — not 24 journeys without holes. Every covered journey below still
names its unasserted branches.

The distribution is itself a finding. The **sound tech has no fully-covered journey at all** — nine
partials and one dormant — while being one of three sides of the market. The **act and venue sides
are covered at the state machine and thin at the page**: what the marketplace *decides* is
exhaustively tested, what a person *reads before deciding* mostly is not.

### Coverage by layer, across all 71

| Layer | Where it is strong | Where it is absent |
|---|---|---|
| Pure domain | booking machine (exhaustive × property), sound plan, reviews, recurrence, cancellation, reliability | display helpers (`soundVerdictClass`), several zod schemas (`techCreateSchema`, `techSubslotCreateSchema`, `inquiryCreateSchema`) |
| DB integration | transitions, locking, account lifecycle, sub-slots, series, saved-search matchers, feed predicates | the wires *between* producers and the worker |
| Route | auth/OTP, admin money, admin status, threads, embed, invite, rebook | `POST /api/performers` (none), `/api/performers/search` (none), `/api/techs/list` (none), `GET /api/tech-subslots` (none) |
| Page | `/slots/[id]`, `/bookings/[id]`, `/me`, `/inbox`, `/performers` | `/slots` (none at all), the public-media gate on all three profile pages, four `/slots` empty states |
| Worker | outbox mechanics (poison, backoff, dead-letter), notify routing, cascade, reconcile | `main()` — no test imports it, so crons, queue names and boot self-heal are unexecuted |
| E2E | 6 specs / 7 journeys: post→apply→offer→accept→rebook, decline→reapply, sound attach, post-gig dispute+review, aged slot, two deactivation paths | profile creation of any kind, `/slots` browse, messaging/inbox, saved-search alerts, media |

---

## How to read a coverage line

Each journey ends with:

```
Coverage — unit: … · integration: … · e2e: … → verdict
```

- **covered** — a regression on the journey's main path fails a test today.
- **partial** — the mechanism is defended somewhere, but at least one load-bearing step is not.
- **uncovered** — nothing fails.
- **dormant** — the journey cannot execute in the launch configuration.

The standard of scepticism is deliberately high, because the repo has several tests that exist,
pass, and cannot fail. They are collected in [Tests that cannot fail](#tests-that-look-like-coverage-and-cannot-fail)
and flagged inline with **⚠ vacuous**.

---

# 1. Act

The demand-side actor the discovery-first launch exists to serve. Seven core journeys; the two most
consequential — creating the profile and finding a gig — are the two with the thinnest coverage in
the whole document.

## A1. Act joins EightGig and creates an act profile — **core**

**What it is.** A performer arrives from the marketing homepage, signs in by email code, fills one
form, and lands on a welcome page that asks for a photo and a track.

**Steps.**
- Discovery: the homepage hero and the three-way role grid are the only entries that name acts —
  `apps/web/src/app/page.tsx:27-45`, `:109-119` ("Set up an act" → `/onboarding?role=performer`),
  founding-member pitch at `:47-61`.
- Signed-out onboarding renders the pitch and pushes to `/login` with a `next` back to itself,
  preserving `source`/`campaign` — `apps/web/src/app/onboarding/page.tsx:49-85`.
- Sign-in is email OTP (journey **X1**) — `apps/web/src/app/api/auth/verify/route.ts:15,77-90`.
- Back signed in, `profileCapabilitiesOwnedBy` resolves whether a profile exists and whether the
  account may act — `apps/web/src/app/onboarding/page.tsx:87-89`, `apps/web/src/lib/auth.ts:189-210`.
  An inactive account short-circuits to a read-only notice before any form renders (`:91-106`).
- The form: name, kind, home metro (**required** — unlike techs, who have no origin field at all),
  bio, genres, rate range in dollars, travel radius, set lengths, tech needs —
  `apps/web/src/app/onboarding/page.tsx:224-258`; duplicated on `/me` at
  `apps/web/src/app/me/page.tsx:164-193`.
- Client transform folds dollars→cents, CSV→arrays, and flat inputs/mics/monitors/unamplified into
  `techNeeds` — `apps/web/src/lib/form-transforms.ts:73-95`.
- `POST /api/performers`: `requireUser`, `performerOwnedBy` duplicate guard (409),
  `performerCreateSchema` with the rate-order refinement — `apps/web/src/app/api/performers/route.ts:16-24`,
  `packages/domain/src/schemas.ts:78-81`.
- One transaction: `lockActiveAccounts` + `assignFounding` + insert + `performer.created` carrying
  the founding rank — `apps/web/src/app/api/performers/route.ts:25-46`; duplicate races map to 409
  through the SQLSTATE mapper at `apps/web/src/lib/profile-create.ts:11-15`.
- Redirect to `/onboarding?role=performer&welcome=1`, which renders the Founding-Member notice and —
  only on the welcome render — the one-time ask for a photo/track link — `page.tsx:230`, `:147-205`.
- The worker turns `performer.created` into two fan-outs: `new_act` to every venue with a matching
  open slot, then `act_welcome` to the act's own owner, **sent last** so an SES throttle mid-fan-out
  cannot duplicate it — `apps/worker/src/index.ts:586-601`, template `apps/worker/src/notify.ts:157-167`.

**What breaks.** `POST /api/performers` is completely untested, so a regression in the duplicate
guard, the founding assignment or the transaction boundary ships silently — while the *tech* route,
which matters less, is defended against exactly these two failures. The `inputs` field is
deliberately defaultless so an unanswered value reads as *unknown* to the sound plan
(`page.tsx:242-252`); nothing tests that a blank submits nothing rather than `0`. The welcome page's
primary CTA is `/slots`, which in a cold Milwaukee market is an empty board.

**Coverage** — unit: `apps/web/src/lib/form-transforms.test.ts:43-66` (the transform);
`packages/db/src/founding.test.ts` (5: monotonic, gap-free on rollback, concurrency-safe, flips off
past the limit) · integration: `apps/web/src/app/onboarding/page.test.tsx:93-106` (a brand-new act is
asked for a photo and a track, **as links**) and `:107-120` (no nag on a later visit);
`apps/worker/src/notify-routing.test.ts:451-471` `act_welcome` routing, `:472-500` suppressed for an
inactive owner; PATCH-side editing is strong at `apps/web/src/app/api/performers/[id]/route.test.ts`
(9) · e2e: **none** — `e2e/booking-journey.spec.ts:143` signs in as the pre-seeded
`band@example.com`, so the whole signup arc is never driven → **partial**

> **Gap G2.** There is no `apps/web/src/app/api/performers/route.test.ts` and no test file imports the
> route. Nothing asserts that creating an act appends `performer.created` — delete the `appendEvent`
> call at `route.ts:38-44` and both `act_welcome` (the only day-one message an act ever gets) and the
> `new_act` venue fan-out go silent with a green suite. The Founding-Member promise is likewise
> untested end to end: `founding.test.ts` stops at the DB function and nothing asserts the notice
> renders (`page.tsx:161-166`) or the badge appears (`me/page.tsx:109-115`).

## A2. Act attaches photos, tracks and video — as links, screened before anyone sees them — **important**

**What it is.** Three surfaces (welcome page, `act_welcome` email, the empty-EPK prompt on the act's
own `/p/{id}`) send the act to `/me` to paste a URL. There is no file picker anywhere.

**Steps.**
- Entry points — `apps/web/src/app/onboarding/page.tsx:191-202`, `apps/worker/src/notify.ts:157-167`,
  `apps/web/src/app/p/[id]/page.tsx:167-177`.
- `MediaManager` renders on the act card of `/me` — `apps/web/src/app/me/page.tsx:159`. A photo, a
  track and a video are all URLs — `apps/web/src/components/MediaManager.tsx:1-7,100-152`. The
  accepted-services sentence is derived from the same allow-list the server enforces, so a provider
  added in `@gigit/domain` cannot go unlisted in the UI (`:42-47`, `:139-143`).
- `submitMediaLink` posts the URL plus an explicit `subjectType` — the route defaults to `performer`,
  so a venue pasting a room photo would otherwise file it against their act (`:56-87`).
- `POST /api/media/embed` normalises to canonical https/lowercase/no-fragment, then **the host
  allow-list, not the client, decides the kind** — `apps/web/src/app/api/media/embed/route.ts:47-65`,
  `apps/web/src/lib/oembed.ts`. Ownership 403 with role-correct copy (`:67-74`); per-kind quota
  (20 photos / 10 audio / 5 video) against the owning profile (`:25-31`, `:76-92`).
- Insert lands `status:'held'` with a position, then appends `media.screen_requested` (`:94-122`).
- The worker screen is the **only** path to `ready`: `mediaFraudScreen` over the link's metadata;
  high risk stays `held` and raises a fraud flag for ops; anything else flips to `ready` —
  `apps/worker/src/media.ts:50-68`. `blocked` is reachable only through the ops queue (journey **O8**).
- Only `ready` assets render publicly, ordered by position; photos become `<img>` from the provider's
  own CDN host, everything else a badged link out — `apps/web/src/app/p/[id]/page.tsx:80-90,107-109,179-219`.
- A weekly recheck HEADs every ready link and emails the owner when one 404s — `apps/worker/src/media.ts:70-104`.

**What breaks.** The status filter — the single line that makes the moderation rail mean anything —
could be deleted from any of the three public pages with a green suite (**G1**). There is **no delete
and no list**: `MediaManager` is add-only, no DELETE route exists (a grep for `schema.mediaAssets`
across `apps/web/src` finds only the embed POST, the admin flag resolver and the three public pages),
yet the quota error at `route.ts:87-92` literally says *"Remove one to add another"*. And
held-forever is invisible: the act sees their own page still say "right now it's just words"
(`p/[id]/page.tsx:118-122` counts only `ready`), with no status, no notification and a prompt that
keeps asking for media they already added.

**Coverage** — unit: `apps/web/src/lib/oembed.test.ts` (rejects http, rejects `bandcamp.com.evil.com`,
strips fragments, pins `imageUrl` to the provider's own CDN and drops `https://evil.example/pixel.jpg`
— this is what makes the `<img src>` safe); `packages/domain/src/schemas.test.ts:44-95` (the real
allow-list, incl. per-act Bandcamp subdomains and `youtube.com.evil.com`);
`apps/web/src/components/MediaManager.test.tsx` (4: no `type="file"` anywhere, every accepted service
named grouped by kind, `subjectType` passed through, a server refusal repeated verbatim) ·
integration: `apps/web/src/app/api/media/embed/route.test.ts` (7–10 against real Postgres and the real
route: provider decides the kind for all four providers, fragment stripped, per-kind quota counts
kinds separately, stranger 403, unclaimed URL 422, anon 401, and **a fresh asset lands `held`**);
`apps/worker/src/media.test.ts` (high-risk stays held + flag, already-decided no-op, dead-link flag for
audio as well as video); `apps/web/src/app/api/authz.test.ts:380` cross-owner attachment ·
e2e: **none** — grepping `flickr|soundcloud|embed|media` across all six specs returns nothing →
**partial**

> **Gap G1 (the headline).** The "only `status=ready` is public" invariant is asserted at **no layer
> for no subject type**. `apps/web/src/app/p/[id]/page.test.tsx:110` hardcodes `status:"ready"` in its
> fixture, and `v/[id]` and `t/[id]` do the same. Deleting
> `eq(schema.mediaAssets.status, "ready")` from `p/[id]/page.tsx:87` publishes every held and blocked
> link and breaks nothing.

## A3. Act browses open gigs and picks a night worth applying to — **core**

**What it is.** The act's front door. Entry points all resolve to `/slots` —
`apps/web/src/app/page.tsx:36,80`; `apps/web/src/app/onboarding/page.tsx:148,178-180`;
`apps/web/src/app/bookings/page.tsx:147`.

**Steps.**
- The page resolves the viewer's capabilities before anything else: a live act sees alerts, an
  owned-but-not-live act sees the account notice, a signed-out visitor sees the join path —
  `apps/web/src/app/slots/page.tsx:28-39`.
- Filters: format chips where `either` is a wildcard **in both directions**, plus a free-text metro
  box lowercased to match how metro is stored — `:22-27`, `:61-88`; the shared predicate builder is
  `packages/db/src/feed.ts:26-56` (`either` at `:36-38`, metro casing at `:40-41`).
- The feed excludes hidden venues (deactivated or suspended owner) and anything at or past downbeat,
  soonest-first, capped at 50 — `packages/db/src/feed.ts:27-33,71-79`.
- Each card carries the decision payload: format, recurring badge, venue name, a link to the room's
  public page, venue-local start time with zone, duration, pay, full street address, the venue's
  note — `apps/web/src/app/slots/page.tsx:158-200`.
- Four distinct empty states — filtered-to-nothing, cold-market-with-an-act, inactive-profile, and
  the signed-out fallback that deliberately offers what an **act** can do rather than telling them to
  post a date — `:89-157`.
- The same query backs the public JSON feed with a 100 cap and a haversine radius filter —
  `apps/web/src/app/api/slots/route.ts:36-58`.

**What breaks.** The act's primary discovery surface has **zero page-level tests**. Every filter is
defended at the DB layer and nothing the act actually reads is defended at all — the venue-local time
with zone, the pay figure, the address, the `/v/{id}` link, the recurring badge, and all four empty
states. The comment at `:135-138` records that this branch previously addressed the wrong actor
entirely, which is exactly the regression a test would catch. The card also publishes the venue's
full street address to anonymous visitors (`:189-197`); the venue-hidden predicate that limits this
lives at `packages/db/src/feed.ts:32` and is asserted only via the API test.

**Coverage** — unit: none needed (predicates live in SQL) · integration:
`apps/web/src/app/api/slots/feed.test.ts` (7, real Postgres, real GET — genuinely good, and it covers
the predicates that had drifted between two copies of this query: open+future+metro, format equality,
`either` as a two-way wildcard, metro matched as typed rather than as stored, the budget floor, and
the radius rule that venues **without** coordinates stay visible rather than vanishing) · e2e:
`e2e/booking-journey.spec.ts` navigates straight to the slot URL it scraped from the venue's own page
(`:133-144`); it never loads `/slots` as an act → **partial**

> **Gap G3.** There is no `apps/web/src/app/slots/page.test.tsx` — contrast `/slots/[id]`,
> `/performers`, `/techs`, `/bookings`, `/me`, `/inbox`, `/p/[id]`, which all have one. The whole
> listing body could render blank and only the DB-level filter test would still pass.

## A4. Act applies to an open night — **core**

**Steps.**
- The slot page loads slot + venue + venue-owner status in one join, then derives `marketplaceOpen` =
  displayed-open AND venue live AND owner active — `apps/web/src/app/slots/[id]/page.tsx:39-53`;
  `effectiveSlotStatus` treats a past open slot as expired **before** the hourly sweep persists it —
  `apps/web/src/lib/slot-display.ts:6-14`.
- The act sees the deal before deciding: pay as the lead figure, venue-local time with zone,
  duration, the venue's note, the full address, the room bio, house-PA and capacity (`:128-148`).
- Four viewer branches: application sent (with Withdraw), a non-submitted outcome explained in words,
  the apply form for a live act, and "Your act profile must be active to apply" (`:149-199`). A
  signed-in visitor with no act profile is offered profile creation; a signed-out one gets sign-in
  with a `next` back here (`:200-214`).
- The application is one optional note — *the profile is the application* (`:183-194`,
  `packages/domain/src/schemas.ts:186-188`).
- `POST /api/slots/{id}/applications`: `requireUser` (also the suspension gate), `performerOwnedBy`
  or 403 — `apps/web/src/app/api/slots/[id]/applications/route.ts:10-17`, `apps/web/src/lib/auth.ts:94-111`.
- In one transaction: `lockActiveProfileOwners` on both sides, then `SELECT … FOR UPDATE` and a
  re-check of both slot status and downbeat, so a stale page cannot slip an application in between
  downbeat and the sweep (`:19-41`).
- Insert `onConflictDoNothing` on `(slotId, performerId)`; if nothing inserted, a previously
  **withdrawn** row is revived rather than 409'd — this is what stops declining an offer from
  dead-ending the pairing forever (`:43-79`). `application.submitted` is appended in the same
  transaction carrying the notify effect to the venue (`:80-90`).
- Tracked under "Your applications" on `/bookings`, 50 most recent — `apps/web/src/app/bookings/page.tsx:74-88,198-232`.

**What breaks.** The optional note — the only free text an act gets to make its case — is untested at
every layer: nothing asserts it persists, that it renders to the venue at `slots/[id]/page.tsx:305-309`,
or that the 1000-char bound holds. The duplicate-apply 409, the 404 for an unknown slot and the 403
for a caller with no act profile are all unasserted at the route layer *for acts* — the **tech**
equivalent is asserted. And nothing asserts the `application.submitted` payload the producer writes
(`route.ts:85-89`): `notify-routing.test.ts:356` hand-builds the event, so changing `to: "venue"` or
misspelling `new_application` at the producer leaves the suite green and the venue simply never hears
that anyone applied.

**Coverage** — unit: `apps/web/src/lib/slot-display.test.ts` (expired-at-downbeat display rule) ·
integration: `apps/web/src/app/slots/[id]/page.test.tsx` (7, real DB, real server component — the
strongest layer, covering exactly the branches this journey turns on: apply hidden after downbeat but
live for future dates `:99-107`, the expired-application explanation `:109-127`, a hidden act getting
"must be active to apply" with no button while an already-applied hidden act keeps Withdraw
`:142-172`, a suspended venue producing "not accepting applications" `:194-208`, `venue_declined` copy
`:231-243`, applications staying open while a booking is `confirming` `:245-304`);
`apps/web/src/app/api/slots/[id]/applications/route.test.ts:47-61` (stale-submission 409) and `:62+`
(happy 201) · e2e: `e2e/booking-journey.spec.ts:144-147` applies against a production build and
asserts the `$415` renders on the listing first; `e2e/aged-slot.spec.ts:67-70` direct POST to a past
slot → 409; `e2e/decline-reapply.spec.ts:52-58` drives the revive path → **covered**

## A5. Act withdraws a still-pending application — **important**

**Steps.** The Withdraw button renders only for an application in `submitted` and only when the
account is active — otherwise "Your account must be active to withdraw"
(`apps/web/src/app/slots/[id]/page.tsx:155-168`). `POST /api/applications/{id}/status` with
`action:'withdraw'` locks the row `FOR UPDATE` and re-checks it, so two stale buttons cannot both
commit contradictory outcomes — `apps/web/src/app/api/applications/[id]/status/route.ts:12-37`;
ownership 403 at `:48-50`; status becomes `withdrawn` with no decline reason and
`application.withdrawn` is appended **deliberately without a notify effect** — a withdrawal is the
act's own action (`:52-85`). The withdrawn row is what the apply route later revives, so withdrawing
is reversible by re-applying.

**What breaks.** Withdrawing after an offer is out is guarded only by the `status !== 'submitted'`
re-check, and no test covers that 409 — i.e. nothing proves an act cannot withdraw an application
that has already been offered the night, which is the exact race the row lock exists for.

**Coverage** — unit: none · integration:
`apps/web/src/app/api/applications/[id]/status/route.test.ts:124-143` (a withdrawal records the status
and notifies nobody), `:144+` (status rolls back when its event cannot persist), `:83-123` (the
venue-decline sibling); `apps/web/src/app/slots/[id]/page.test.tsx:162-172` (Withdraw survives for an
act whose profile went hidden after applying) · e2e: only `e2e/decline-reapply.spec.ts`, and it goes
through `PERFORMER_DECLINED` rather than an explicit withdraw → **partial**

## A6. Act receives a firm offer and reads the whole deal — **core**

**Steps.**
- Offer from an application: the venue's route re-checks application status, slot status and
  downbeat, enforces that the offer amount **equals** the advertised pay, then `createOffer` locks
  the terms from the slot — `apps/web/src/app/api/applications/[id]/offer/route.ts:17-73`.
- Offer without an application: `/api/slots/{id}/invite` creates application and offer in one
  transaction, so a cold invite arrives as a *firm offer at the published pay* rather than as a DM
  with terms typed into chat — `apps/web/src/app/api/slots/[id]/invite/route.ts:33-83`.
- The booking row is inserted directly in `offered` and the reducer's creation effects arm the expiry
  timer and notify the act — `packages/domain/src/booking/machine.ts:267-273`,
  `packages/db/src/transition.ts:756,775`. The TTL is clamped so an offer can never outlive the gig
  it is for (`:603`, `:654`).
- On `/bookings` the offer shows the respond-by deadline and role-correct link copy ("Review the deal
  and respond" for the act, "Review or withdraw" for the venue) — `apps/web/src/app/bookings/page.tsx:170-182`.
- On `/bookings/{id}` the act sees the state badge, the pay as the lead figure, the venue-local
  datetime, the address, and the explicit promise that the venue cannot offer this night to anyone
  else while the offer is live — `apps/web/src/app/bookings/[id]/page.tsx:272-299`. The sound plan is
  shown at offer time with the gaps spelled out (`:369-386`), the full agreement is rendered from the
  locked terms with accept/decline **underneath** it (`:633-663`,
  `packages/domain/src/agreement.ts`), and day-of contacts are deliberately **not** revealed yet
  (`:133-141`, `apps/web/src/lib/booking-display.ts`).
- The booking thread is created by the offer transaction, so the act can ask a question before
  accepting (journey **X6**).

**What breaks.** Nothing asserts the act is actually *told*. `offer_received` is emitted by
`offerCreatedEffects` (`packages/domain/src/booking/machine.ts:271`) and
`apps/worker/src/notify-routing.test.ts` never drives it — the routing suite covers application, OTP,
message, sound and suspension events, not this one.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts` (creation effects);
`apps/web/src/lib/booking-display.test.ts` (4 — contacts stay hidden while an offer is only a
proposal and are never revealed by cancelling an unconfirmed offer) · integration:
`packages/db/src/transition.test.ts` is the deep layer — one live offer per slot (`:685-729`), a second
offer rejected without taking the slot from payment confirmation (`:730+`), `endsAt` validation
(`:835-852`), offer amount must match advertised pay (`:853+`), offers refused to a hidden act or a
suspended owner (`:1119-1171`), TTL never outliving the gig (`:307-388`);
`apps/web/src/app/api/authz.test.ts:195-332`; `packages/db/src/invites.test.ts:15` (atomic
invited-offer rollback) · e2e: `e2e/booking-journey.spec.ts:154-158` asserts the act sees "The deal,
in writing" and the `$415`; `e2e/decline-reapply.spec.ts:36-41` drives the invite path →
**covered**

## A7. Act accepts the offer and the night confirms — **core**

**Steps.** `POST /api/bookings/{id}/accept` requires `acceptedTerms: true` as a literal — an accept
cannot be a stray POST (`apps/web/src/app/api/bookings/[id]/accept/route.ts:19-21`); `performerOwnedBy`
+ ownership 403 (`:31-40`); a payout-readiness gate that the Null gateway always passes but which
exists so a booking can never confirm with nowhere to send money (`:47-52`); then
`runBookingTransition(PERFORMER_ACCEPTED)` → `confirming` with effects `[cancel_schedule,
request_payment]`. The worker charges — Null gateway means immediate `PAYMENT_SUCCEEDED` → `confirmed`,
which fills the slot, declines rival applications and arms the gig-end timer
(`technical-design.md` §6.1). Five distinct 409s are mapped by name: `offer_expired`,
`performer_unavailable` (the double-book guard), `illegal_transition`, concurrent update, and
`slot_unavailable`.

**What breaks.** The double-book guard is the interesting one — accepting two offers at the same
hour must fail, and it does.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts` (exhaustive state×event) +
`machine.property.test.ts` · integration:
`apps/web/src/app/api/bookings/[id]/accept/route.test.ts` (6 — moves to `confirming` for the offer's
performer; 403 a different performer; **requires the explicit `acceptedTerms` consent**;
`offer_expired` after the TTL; blocks an overlapping second booking; 404 missing);
`apps/web/src/app/api/authz.test.ts:142-158` (incl. 403 when the account is suspended, through the
shared `requireUser` lock) · e2e: `e2e/booking-journey.spec.ts:192-204` waits for the **Confirmed**
badge produced by the real worker draining real outbox rows → **covered**

## A8. Act declines a firm offer and the night reopens — **important**

**Steps.** The same `POST /api/bookings/{id}/cancel` routes by actor and state:
`asPerformer && state === 'offered'` → `PERFORMER_DECLINED`, otherwise `PERFORMER_CANCELLED`
(`apps/web/src/app/api/bookings/[id]/cancel/route.ts:23-29`). The decline collapses the booking,
reopens the slot in-transaction, withdraws the application, and — critically — leaves the pairing
re-appliable, which is what journey **A4**'s revive path picks up.

**Coverage** — unit: machine table · integration:
`apps/web/src/app/api/bookings/[id]/cancel/route.test.ts:122` (performer declining an offered booking
is a decline, application withdrawn); `apps/web/src/app/api/authz.test.ts:171` · e2e:
`e2e/decline-reapply.spec.ts` drives the whole arc — declined offer → slot reopens → same act
re-applies → second offer confirms → **covered**

## A9. Act plays the night — **core**

**Steps.** After `confirmed`, day-of contacts unlock and stay unlocked
(`apps/web/src/lib/booking-display.ts:3-24` — the visible set is `confirmed`,
`awaiting_confirmation`, `disputed`, `released`, `refunded`, `partially_released`, plus cancelled-only-
if-it-was-ever-confirmed). A day-before reminder is armed on entering `confirmed` and **re-checks the
booking is still confirmed at fire time** (`apps/worker/src/index.ts:123-135`, `:658-682`). The gig-end
timer moves the booking to `awaiting_confirmation`, the act can record "we played"
(`POST /api/bookings/{id}/mark-played`, performer-only, only after the set is over —
`apps/web/src/app/api/bookings/[id]/mark-played/route.ts:15-38`), and the night releases on venue
confirm or the +24h auto-confirm. The booking also appears in the act's own calendar (journey **X9**).

**What breaks.** The day-before reminder's staleness re-check has **no test at all** — a reminder
texted for a booking cancelled hours earlier would pass everything. A booking confirmed inside 24h of
downbeat silently gets no reminder (`index.ts:670`). And the reminder/contact path is the one place
the SMS gap bites hardest: `users.phone` is never populated by any web signup (journey **X2**), so the
day-of contact reveal renders a blank phone for every web user.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts:158` (gig end schedules auto-confirm
24h out), `:168` (auto-confirm releases the full amount); `apps/web/src/lib/booking-display.test.ts`
(4) · integration: `apps/web/src/app/api/bookings/[id]/postgig.test.ts:140` (mark-played only after
the gig ends and only by the performer); `apps/worker/src/reconcile-loop.test.ts:154` (a lost gig-end
timer is re-armed) · e2e: `e2e/post-gig.spec.ts` drives past-dated bookings from seeded fixtures — no
spec waits on a real pg-boss timer → **partial**

## A10. Act cancels a confirmed booking — **important**

**Steps.** `PERFORMER_CANCELLED` → `cancelled_by_performer`; in-transaction the slot reopens (only if
downbeat is still ahead) and a reliability strike lands on `performers.reliability_strikes`; the
confirmation copy is generated from the same downbeat-aware rule the transition uses, so the dialog
cannot promise "the date reopens" when it will not —
`apps/web/src/lib/booking-display.ts:32-60`, `apps/web/src/app/bookings/[id]/page.tsx:124,312`.
`performerCancellationFee` is always a full refund to the venue — and, with payments off, that is a
ledger row nobody settles.

**Coverage** — unit: `packages/domain/src/cancellation.test.ts` (fee windows incl. boundaries) +
the property test asserting `fee + refund == amount` on every random path;
`apps/web/src/lib/booking-display.test.ts` · integration:
`apps/web/src/app/api/bookings/[id]/cancel/route.test.ts:156` (performer cancelling a confirmed
booking lands `cancelled_by_performer`); `apps/web/src/lib/booking-history.test.ts:20`
(pre-confirm vs post-confirm cancellation are distinguished, which is what keeps contacts visible
after a confirmed cancellation) · e2e: **none** → **partial**

## A11. Act raises a dispute after the night — **important**

**Steps.** Either party, in the post-gig window only: `POST /api/bookings/{id}/dispute` with a
category enum and a 5–2000 char reason, routed to `DISPUTE_OPENED` with `openedBy` derived from the
caller's role — `apps/web/src/app/api/bookings/[id]/dispute/route.ts:12-37`. The transition pauses
release by construction (the auto-confirm timer becomes a no-op) and the reason is persisted into the
event log for ops. Resolution is journey **O11**.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts:235-306` (dispute resolutions:
partial splits must conserve the total, negative and non-integer legs rejected) · integration:
`apps/web/src/app/api/bookings/[id]/postgig.test.ts:152` (either party can open one, strangers
cannot), `:185` (outside the window is a 409, reasons validated);
`packages/db/src/transition.test.ts:1208` (`DISPUTE_OPENED` persists `openedBy` + reason) · e2e:
`e2e/post-gig.spec.ts:78` drives the full arc against a production build → **covered**

## A12. Act edits its profile, rates and availability — **important**

**Steps.** The `/me` act card re-renders the same field set as onboarding
(`apps/web/src/app/me/page.tsx:164-193`) and PATCHes `/api/performers/[id]` with explicit-clear
semantics: an empty string clears text, an explicit `null` clears a number. The rate-order refinement
is enforced against the *persisted* pair, not just the submitted one, and concurrent partial edits are
serialised so the saved pair can never end up inverted.

**Coverage** — unit: `packages/domain/src/schemas.ts:78-81` refinement, exercised through the route ·
integration: `apps/web/src/app/api/performers/[id]/route.test.ts` (9 — public GET projects only
public fields; metro lowercased by the schema; a floor above the ceiling rejected; a new floor above
the *persisted* ceiling rejected **without changing either rate**; the mirror case; **concurrent
partial rate edits serialised so the saved pair stays ordered**; either bound clearable then
independently updatable; optional copy and lists cleared and read back; non-owner 403) ·
e2e: none → **covered**

## A13. Act saves a gig alert and is told when one fits — **core** *(cross-cutting, act-owned)*

**What it is.** The liquidity mechanism the discovery-first launch depends on: an act with no reason
to check the feed daily still hears about gigs that fit.

**Steps.** The alerts card renders only for accounts with an act profile
(`apps/web/src/app/slots/page.tsx:95-99,203-238`). `POST /api/saved-searches` requires an act profile
and stores format/metro/minBudgetCents with any of them null meaning *anything*; metro is normalised
lowercase by `metroSchema` so worker matching hits
(`apps/web/src/app/api/saved-searches/route.ts:8-36`). A venue posting appends `slot.created`; a
cancelled booking reopening the night appends `slot.applicants_revived` — both are treated as news
(`apps/worker/src/index.ts:564`). `matchSavedSearches` applies the wildcard rule **symmetrically on
both sides** and filters to a live act, an active recipient, a live source venue with an active
owner, an open slot and a future start — `packages/db/src/analytics.ts:48-72`.

**What breaks.** A false negative — a missed gig — is the expensive failure and is invisible to both
sides. The `either` inversion was exactly this bug: the "Music or comedy" option the form offers
matched nothing but `either` slots.

**Coverage** — unit: none (SQL) · integration: the matcher is very well tested
(`packages/db/src/analytics.test.ts:192` covers format/metro/budget, both `either` directions, hidden
profile, suspended owner) and the CRUD route is tested
(`apps/web/src/app/api/saved-searches/saved-searches.test.ts`, 3) · e2e: **none** → **partial**

> **Gap G4a.** The wire between them — `apps/worker/src/index.ts:564-570` — is tested by nothing. A
> regression that stops calling `matchSavedSearches`, or routes it to the wrong template, passes the
> whole suite.

## A14. Act sends someone its EightGig page — **important** *(cross-cutting, act-owned)*

**What it is.** The product's only organic distribution channel: one URL that survives being pasted
anywhere and unfurls with the act's own name and bio.

**Steps.** The owner finds the link on `/me` (`apps/web/src/app/me/page.tsx:117,229`); `act_welcome`
frames that page as the thing you send to a venue (`apps/worker/src/notify.ts:157-167`). The page body
refuses anything not `live` (`apps/web/src/app/p/[id]/page.tsx:76-78`), and `generateMetadata` runs a
**second, independent gate that fails closed** on any status other than `live`, because a crawler
rendering a link preview never executes the page body — `apps/web/src/lib/profile-metadata.ts:1-28`.
Media is link-only and badged with the provider; reviews (double-blind filtered) and the reliability
badge render inline; an empty page says nothing apologetic to a visitor — only the **owner** is told
what is missing, because only the owner can act on it (`:111-122,146-155`).

**Coverage** — unit: `apps/web/src/lib/profile-metadata.test.ts:53` (the fail-closed unfurl gate,
including an invented-future-status case) · integration:
`apps/web/src/app/p/[id]/page.test.tsx` (8 — owner-vs-visitor prompts, bio line breaks preserved,
photo/track/video rendering) · e2e: `e2e/account-lifecycle.spec.ts` asserts a 404 on a suspended
venue's public URL → **partial**

> **Gap G7.** There is no unit test that the page **body** 404s a hidden profile — only the metadata
> layer is pinned. And media never leaving `held` (the **G1** family) means the act's photo silently
> does not appear on the page they just sent, with no notification for "still under review".

---

# 2. Venue

The supply side, and the actor with the most levers. Seven core journeys. Coverage is strongest
exactly where the money used to be (offer, cancel, rebook) and weakest on the two things a venue does
every week: reading applicants and searching for acts.

## V1. Venue joins and creates a room profile — **core**

**Steps.** `/onboarding?role=venue` renders the room form — name, kind, street address, city, an
**optional** "scene to be listed in", state, ZIP, time zone, bio, capacity, and the PA block
(`apps/web/src/app/onboarding/page.tsx:260-330`). Two deliberate details live here: the metro field is
optional and sits directly after City with copy explaining what it is *for*, because it used to be
required, labelled "City or metro area", and separated from City by ZIP — so venues typed Milwaukee
twice into two boxes that looked like the same question (`:283-290`). And `hasOperator` defaults to
**"Not sure yet"**, which submits nothing, so the sound plan sees `undefined` and returns `unknown`;
it used to default to `"false"`, which made every venue that skipped the question assert "there is
nobody" on its own behalf (`:315-329`).

`POST /api/venues` guards duplicates (409), derives `metro` from the city when unnamed, resolves an
approximate metro centroid for radius search — storing **null rather than a fabricated point** for
unknown metros, because a fabricated point would hide the venue from every radius search — then in
one transaction takes the account lock, assigns the founding rank, inserts, and appends
`venue.created` — `apps/web/src/app/api/venues/route.ts:17-63`.

**What breaks.** The same shape as **A1**: the founding assignment, the duplicate 409 and the
event-append rollback are all inside one transaction and none of them has a dedicated route test. The
route *is* executed — but as a fixture helper.

**Coverage** — unit: `apps/web/src/lib/form-transforms.test.ts:85-113` (the `venueGear` transform:
`hasOperator` omitted entirely when unanswered, explicit true/false surviving — this is the input path
that makes the `unknown` verdict reachable from the real form at all);
`packages/db/src/founding.test.ts` (5) · integration:
`apps/web/src/app/api/slots/create.test.ts:167-199` drives the **real** `POST /api/venues` and asserts
metro derivation — "derives the metro from the city, normalized the way the feed matches it" and
"still lets a venue name a different scene than its city". That is real coverage of the derivation and
of nothing else · e2e: `e2e/booking-journey.spec.ts` uses the seeded venue → **partial**

## V2. Venue posts an open date — **core**

**Steps.** `/slots/new` gates three ways before showing a form: no venue profile → create one;
owned-but-not-live → "posting is unavailable"; **location incomplete → "Finish your venue location"**,
because address and time zone keep the listing, the offer and the calendar invite aligned
(`apps/web/src/app/slots/new/page.tsx:14-42`). The AI slot-parse widget renders **only when a model
is configured** (`:54`) — it used to render first on the page and answer "the assistant isn't
available right now", on the flagship "post a slot in a text message" promise. The form takes start,
duration, format, **pay (required — transparency is enforced in the schema)** and notes, entered in the
venue's own time zone (`:63-75`).

`POST /api/slots` re-checks the venue profile and the location completeness server-side, then
`createOpenSlot` commits the slot and its `slot.created` outbox event together —
`apps/web/src/app/api/slots/route.ts:7-36`. That event is what drives saved-search alerts (**A13**).

**Coverage** — unit: `packages/domain/src/schemas.ts` slot schema, exercised through the route ·
integration: `apps/web/src/app/api/slots/create.test.ts` (9 — creates for a complete venue; refuses a
venue with no address or timezone **and says why**; refuses a past date in words a venue owner would
use; returns a clean conflict when the date passes at the persistence boundary; 403 no venue profile;
401 anonymous; plus the two metro-derivation cases); `packages/db/src/open-slots.test.ts` (2 — commits
a future slot and its outbox event **together**; rejects a stale start at the commit boundary with
neither a slot nor an event) · e2e: `e2e/booking-journey.spec.ts:61` posts a real night through the
real form against a production build → **covered**

## V3. Venue runs a recurring night — **important**

**Steps.** The same page offers a collapsed "Make it a series" form
(`apps/web/src/app/slots/new/page.tsx:78-104`). `POST /api/series` anchors the pattern on the **first
occurrence's** weekday and time-of-day in the venue's zone (`patternFromFirst`) and stores per-night
defaults — `apps/web/src/app/api/series/route.ts:11-49`. A nightly 04:20 job keeps every active series
at full horizon as occurrences pass (`apps/worker/src/index.ts:173-180`). Cancelling closes future
**unfilled** occurrences and stops materialisation; booked nights stand — and a series with an
outstanding offer refuses to cancel with `offer_outstanding` rather than yanking a date out from under
a live deal (`apps/web/src/app/api/series/[id]/cancel/route.ts:28-37`).

**Coverage** — unit: `packages/domain/src/recurrence.test.ts` (16, incl. DST fall-back resolving to
the earlier instant and being **stable across calls** — which is exactly what series idempotency rests
on) · integration: `packages/db/src/series.test.ts` (10 — creates and materialises the full horizon;
materialises the exact selected first night first and remains idempotent; rolls back series **and**
event when initial materialisation fails; re-materialising is idempotent; cancelling closes future
open occurrences and stops materialisation; leaves the series active while an occurrence is
`confirming`; **materialises a venue-local pattern that holds its wall time across DST**);
`apps/web/src/app/api/series/route.test.ts:45` (the selected first night is the persisted lower bound)
· e2e: `e2e/booking-journey.spec.ts:120-130` asserts four anchored cards with the selected first-night
label → **covered**

## V4. Venue edits or closes an open date — **important**

**Steps.** `PATCH /api/slots/[id]` and `DELETE /api/slots/[id]` share one owner-guard: the caller's
venue owns it **and** it is still `open` (`apps/web/src/app/api/slots/[id]/route.ts:30-41`). The edit
runs inside a transaction that takes the **same slot row lock `createOffer` takes**, so an edit cannot
race an offer and leave the public listing different from the locked deal (`:53-72`), and it refuses
outright while any booking in `SLOT_HOLDING_BOOKING_STATES` holds the date (`:62-71`, 409
`offer_outstanding`). Closing routes through `cancelOpenSlots`, which resolves the pending
applications rather than orphaning them.

**Coverage** — unit: none · integration: `apps/web/src/app/api/slots/[id]/route.test.ts` (5 — owner
edits budget and notes; owner closes and **resolves its pending applications**; a non-owner can
neither edit nor close, no IDOR; a closed slot can't be edited, 409, and unauthenticated is 401;
**won't edit or close a slot held by an offered or confirming booking**) · e2e:
`e2e/aged-slot.spec.ts:76-95` asserts the venue's post-downbeat view → **covered**

## V5. Venue reads its applicants and sends a firm offer — **core**

**Steps.** The applicant list is venue-owner-only (`apps/web/src/app/slots/[id]/page.tsx:275+`). Each
card carries the decision payload: act name linking to `/p/{id}`, act kind, **reliability badge**
derived from released bookings and cancellation strikes, application status, the **per-applicant sound
verdict** computed live from this room's PA against that act's needs, the gap list, the bio, and the
act's note. Offering routes through `POST /api/applications/[id]/offer`, which re-checks that the
application is `submitted`, the slot `open` and the date future, runs the shared payment-readiness
gate, **enforces that the offer equals the advertised pay** (`offer_amount_mismatch`, 400 — "Edit the
slot before making an offer"), and locks the terms from the slot rather than from typing
(`apps/web/src/app/api/applications/[id]/offer/route.ts:17-73`). Exactly one live offer per slot;
a second returns 409 with the remedy named.

**What breaks.** The offer route is well defended. The **applicant card** is not: nothing asserts the
reliability badge, the per-applicant sound verdict (`page.tsx:282`, badged at `:298-299`), the gap
list, or the act's note render at all. `apps/web/src/app/slots/[id]/page.test.tsx` has zero
occurrences of "sound", "plan" or "verdict".

**Coverage** — unit: `packages/domain/src/reliability.test.ts` (6, incl. a brand-new act reading as
"New to EightGig — no gigs yet" rather than a zero score); `packages/domain/src/soundplan.test.ts` (16)
· integration: `apps/web/src/app/api/authz.test.ts:195-332` (403 when the caller doesn't own the
slot's venue; payment readiness required before creating a booking; **enforces advertised pay and one
firm offer per slot**; rejects a stale open date after its start time with accurate copy) and `:343`
(**a rival venue cannot read who applied to someone else's date**);
`packages/db/src/transition.test.ts:685-729`; `apps/web/src/app/slots/[id]/page.test.tsx:129`
(venue manage/offer/decline controls hidden after downbeat), `:142` (historical ownership readable but
read-only), `:194` (a live target profile required for new slot actions), `:245` (terms frozen while
confirmation runs but applications stay open) · e2e: `e2e/booking-journey.spec.ts` sends the offer
against a production build; `e2e/aged-slot.spec.ts:91` asserts the post-downbeat applicant card →
**partial**

## V6. Venue invites an act directly onto an open date — **important**

**What it is.** One step, straight onto the offer rail. The route's own comment records why it exists:
two shipped templates (`new_act`, `slot_quiet`) tell venues to "send an invite" and `/performers` is
commented "search + invite", but no invite endpoint existed — so both cold-start nudges dead-ended in
a free-text DM whose placeholder pushed terms into unstructured chat
(`apps/web/src/app/api/slots/[id]/invite/route.ts:17-32`).

**Steps.** Ownership of the date, date still open and future, target act `live`, shared payment-
readiness gate, then `createInvitedOffer` — which prepares (or **revives**) the application and creates
the firm offer **in one transaction**, so a competing live offer cannot leave behind a synthetic or
spuriously revived application when this returns 409 (`:44-93`). The pay is the pay the venue already
published.

**Coverage** — unit: `apps/web/src/lib/invite-display.test.ts` (the date label includes date, local
time, format and listed budget) · integration:
`apps/web/src/app/api/slots/[id]/invite/route.test.ts` (8 — creates application **and** firm offer in
one step; no invite when the venue cannot be charged; reuses an application the act already submitted;
**revives a passed-over application rather than dead-ending**; no application created when another act
already holds the offer; the current holder's application stays `offered` when they are re-invited;
403 not-yours and 409 not-open; 404 hidden or missing act; 403 no venue profile);
`packages/db/src/invites.test.ts:15` (rolls back **both** a synthetic and a revived application when
the offer conflicts) · e2e: `e2e/decline-reapply.spec.ts:36-41` → **covered**

## V7. Venue withdraws an offer — **important**

**Steps.** The same cancel route: `asVenue` → `VENUE_CANCELLED`, which on an `offered` booking
collapses it and reopens the slot in-transaction
(`apps/web/src/app/api/bookings/[id]/cancel/route.ts:23`). The slot page then unfreezes: the "Date on
hold" card disappears and listing terms become editable again
(`apps/web/src/app/slots/[id]/page.tsx:255-274`).

**What breaks.** `offer_withdrawn` is one of the 14 named templates in `technical-design.md` §3.5, and
nothing drives it through `notify-routing.test.ts`. The act whose offer was pulled is told by a
notification path no test exercises.

**Coverage** — unit: machine table · integration:
`apps/web/src/app/api/bookings/[id]/cancel/route.test.ts:103` (venue cancelling an offered booking
withdraws the offer, lands `collapsed`, and reopens the slot);
`apps/web/src/app/api/authz.test.ts:184` (403 a non-party, 200 a party) · e2e: none → **partial**

## V8. Venue searches the act directory and shortlists — **important**

**Steps.** `/performers` is venue-gated on purpose: this page invites and messages acts, and only a
venue may open a conversation (no cold DMs, `technical-design.md` §4.7). An act who lands here is not
told to go set up a venue — it is pointed at `/slots` and `/venues`, because telling a band to become
a room is a dead end (`apps/web/src/app/performers/page.tsx:27-54`). Filters are kind, genre
(`genreTags @> [...]`) and metro (lowercased to match storage); ordering is **`reliabilityStrikes` asc,
then `createdAt` asc**, capped at 100 (`:70-92`). The page also loads the venue's **own** open nights,
excluding any night already held by a booking, so an invite can name a real date instead of pushing
terms into chat (`:97-124`).

**What breaks.** The search itself has no test at any layer: neither filter, neither the ordering, nor
the 100 cap. There is also a parallel JSON surface, `GET /api/performers/search`, with **no test file
and no in-app consumer** — the same shape as `/api/techs/list` and `GET /api/tech-subslots`.

**Coverage** — unit: `apps/web/src/lib/invite-display.test.ts` · integration:
`apps/web/src/app/performers/page.test.tsx` (2 — **offers only genuinely free dates in the invite
form**, i.e. the `notExists` holding-booking join; and **does not tell an act to go set up a venue**) ·
e2e: `e2e/aged-slot.spec.ts:125-138` asserts an expired night disappears from the invite date picker →
**partial**

## V9. Venue runs the night and confirms it happened — **core**

**Steps.** Day-of contacts unlock at `confirmed` and stay unlocked
(`apps/web/src/lib/booking-display.ts:3-24`; the page says so explicitly at
`apps/web/src/app/bookings/[id]/page.tsx:525,566`). After the gig-end timer moves the booking to
`awaiting_confirmation`, the venue can release immediately with
`POST /api/bookings/{id}/confirm` — `VENUE_CONFIRMED` is legal **only** in `awaiting_confirmation`
(`apps/web/src/app/api/bookings/[id]/confirm/route.ts:20-43`). The route's comment records why it
exists: without it the only path to `released` was the 24h auto-confirm timer, so a venue ready to pay
had no way to do it. Otherwise auto-confirm fires at +24h.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts:158,168`;
`apps/web/src/lib/booking-display.test.ts` (4) · integration:
`apps/web/src/app/api/bookings/[id]/confirm/route.test.ts` (3 — 409 before the gig ends, still
`confirmed`; 403 for the performer and 200 + `released` for the venue post-gig; 404 missing, 401
unauthenticated); `apps/worker/src/reconcile-loop.test.ts:154` (auto-confirms an overdue night) ·
e2e: `e2e/post-gig.spec.ts` drives the whole post-gig arc → **covered**

## V10. Venue cancels a confirmed booking — **important**

**Steps.** `VENUE_CANCELLED` → `cancelled_by_venue`; in-transaction the slot reopens **only if
downbeat is still ahead**, a reliability strike lands on the venue, and the fee schedule computes
(>14d: 0%; 48h–14d: 50%; <48h: 100% to the act) — dormant as money, live as a record. The confirm
dialog is generated from the same downbeat-aware rule, and with payments off it says "Settle any pay
directly with the act" rather than quoting a fee — `apps/web/src/lib/booking-display.ts:32-60`.
Any active sound sub-slot cascades (journey **T7**).

**Coverage** — unit: `packages/domain/src/cancellation.test.ts` + the fee/refund property test;
`apps/web/src/lib/booking-display.test.ts` · integration:
`apps/web/src/app/api/bookings/[id]/cancel/route.test.ts:135` (venue cancelling a confirmed booking
lands `cancelled_by_venue` **with a strike**), `:164` (a non-party 403 changes nothing);
`apps/web/src/lib/booking-history.test.ts:20`; `apps/worker/src/cascade.test.ts` (2) · e2e:
`e2e/account-lifecycle.spec.ts:35` drives cancellation through admin suspension against a production
build → **covered**

## V11. Venue re-books the same act into the next open night — **important**

**What it is.** The anti-leakage loop: after a good night, the repeat booking happens on-platform
instead of by text message.

**Steps.** `POST /api/bookings/{id}/rebook` verifies the caller owns the booking's venue, then
`findRebookTarget` picks the next compatible open upcoming night at that room — **preferring a night
in the same series**, while one-off bookings still get a useful repeat path — and offers at *that
night's* advertised pay, not the old one (`apps/web/src/app/api/bookings/[id]/rebook/route.ts:21-65`).
It reuses `createInvitedOffer`, so application preparation/revival and the firm offer share one
transaction and a lost race leaks no synthetic application.

**Coverage** — unit: none · integration:
`apps/web/src/app/api/bookings/[id]/postgig.test.ts` (5 — re-books the same act into the next open
series night; **will not offer a hidden act or an act whose account is suspended**; a non-series
booking is a clean 409; no rebook when the venue cannot be charged; **returns a clean conflict and
rolls back its synthetic application**); `packages/db/src/series.test.ts:358,444` (`findRebookTarget`
for a series night and for a one-off, skipping applied/ineligible) · e2e:
`e2e/booking-journey.spec.ts:208-230` re-books and confirms the repeat against a production build →
**covered**

## V12. Venue's room is listed publicly — **important**

**Steps.** `/venues` is read-only on purpose — no contact affordance, so the no-cold-DM policy stays
intact (`apps/web/src/app/venues/page.tsx:17-25`). It exists because an act's day one used to be an
empty feed and nothing else. Cards carry kind, founding badge, cancellation strikes, capacity, house
PA (with the honest "not confirmed" vs "no house sound tech" distinction), curfew, and an open-night
count. `/v/[id]` gates on `status === 'live'` in the body and again, independently, in
`generateMetadata`.

**Coverage** — unit: `apps/web/src/lib/sound-display.test.ts:16-31` (`equipmentCount`:
undefined → "microphone count not listed" vs 0 → "0 microphones"; `houseOperatorLabel`: undefined →
"not confirmed" vs false → "no house sound tech");
`apps/web/src/lib/profile-metadata.test.ts:53` · integration:
`apps/web/src/app/venues/page.test.tsx` (1 — **counts only future open dates for live rooms**);
`apps/web/src/app/v/[id]/page.test.tsx` (2 — a room photo renders from the host that serves it; links
out when the provider handed back no image); `apps/web/src/app/api/venues/[id]/route.test.ts:39`
(explicit text, nullable number and **nested gear clears** persist on reload);
`apps/web/src/app/api/authz.test.ts:360` (a rival cannot rewrite another venue's address or capacity)
· e2e: `e2e/account-lifecycle.spec.ts:57-65` asserts the directory card and its "1 open night" count,
then its removal after suspension → **partial**

> `v/[id]/page.test.tsx:34` hardcodes `status:"ready"` on its media fixture — the **G1** family again.
> The venue page's performer-authored review rendering (`v/[id]/page.tsx:80-82,175`) is unasserted.

## V13–V17. Venue journeys that live in the sound-tech rail

Five venue-actor journeys are enumerated in §3 because the tech is the other party and the coverage
material sits there:

| # | Journey | Criticality | Verdict |
|---|---|---|---|
| V13 | [The sound plan tells a confirmed booking whether it needs a tech](#t-sp-sound-plan-verdict) | core | partial |
| V14 | [A booking party posts a paid sound job](#t-post-sound-job) | core | partial |
| V15 | [The paying side selects an applicant and books the tech](#t-payer-books) | core | partial |
| V16 | [A venue or act cold-messages a tech](#t-messaged-directly) | important | partial |
| V17 | [Open a cold conversation with a profile (inquiry thread)](#x7-inquiry-thread) | important | covered |

---

# 3. Sound tech

The **conditional, derived third side** of the market (`technical-design.md` §4.10): engaged only on
the subset of bookings the sound plan flags as uncovered, measured by attach rate rather than raw tech
count. **Ten tech-actor journeys, none fully covered, one dormant.** Where the act and venue rails have
E2E and page tests, the tech rail has deep DB integration and almost nothing above it.

Six entries below belong to other actors but are documented here because the tech is the counterparty
and the material is contiguous: **T3** is cross-cutting (=X10), **T4/T5/T6/T9** are venue journeys
(=V16/V13/V14/V15), and **T15** is an ops journey (=O20). Each is counted once, under its own actor, in
the summary table.

## T1. Sound tech joins and creates a tech profile — **core**

**Steps.** `/onboarding?role=tech` → signed-out pitch (`apps/web/src/app/onboarding/page.tsx:49-84`) →
capability resolution (`:87-88`, `apps/web/src/lib/auth.ts:189-210`) → inactive-account short-circuit
(`:91-106`) → the form: name, gear enum `none|partial|full_rig`, bio, labor rate, rate-with-rig,
travel radius (`:335-356`). `POST /api/techs` guards duplicates, then one transaction:
`lockActiveAccounts` + insert + `tech.created` (`apps/web/src/app/api/techs/route.ts:10-33`). Redirect
goes to `/techs` — deliberately not `/bookings`, because a new tech has none (`:341-345`).

**What breaks.** Techs are **structurally excluded** from the Founding-Member offer acts and venues
get — a hardcoded `role !== "tech"` in two places (`page.tsx:73`, `:212`) with no test either way. The
`techs` table has **no metro or home city** at all (`packages/db/src/schema.ts:191-203`): a
Milwaukee-first marketplace cannot tell where its techs are, and `travelRadiusMiles` has no origin to
measure from. That is a schema gap, not a coverage gap — no test could catch it.

**Coverage** — unit: `apps/web/src/components/ApiForm.test.tsx:54-88` (the dollars→cents conversion the
rate fields depend on, keyed off the `*Cents` suffix). `techCreateSchema` itself is **untested** — the
gear enum, name/bio bounds, the travel-radius default and max are asserted nowhere, so the form's
hardcoded gear options could drift from the enum silently · integration:
`apps/web/src/app/api/techs/route.test.ts` (2 — two concurrent POSTs yield exactly `[201, 409]`, one
row, one event, exact copy; and a real `before insert on events` trigger forces the event append to
fail and the test asserts **zero** techs rows — driven through real Postgres, not a throwing mock);
`apps/web/src/lib/auth.profile-order.test.ts:47-77` · e2e: **none** — no spec visits
`/onboarding?role=tech` → **partial**

> **⚠ vacuous.** `route.test.ts` only ever selects `schema.techs.id` and `schema.events.id`. It
> asserts row **counts**, never **values**. Drop `gear` from the insert, swap the two rate columns, or
> stop applying `parsed.data` entirely, and both tests still pass.

<a id="t2-tech-media"></a>
## T2. Sound tech adds gear photos and mix links — **peripheral**

Same mechanism as **A2**, mounted with `subjectType='tech'` (`apps/web/src/app/me/page.tsx:446`).
Public rendering at `apps/web/src/app/t/[id]/page.tsx:39-47,113-145`.

**Coverage** — unit: `apps/web/src/lib/oembed.test.ts`; `packages/domain/src/schemas.test.ts:44-95`;
`apps/web/src/components/MediaManager.test.tsx` (4) · integration:
`apps/web/src/app/api/media/embed/route.test.ts` (covers `performer` and `venue` — **never `tech`**, so
the `techOwnedBy` branch at `route.ts:72` is never taken); `apps/worker/src/media.test.ts`;
`apps/web/src/app/t/[id]/page.test.tsx` (1 — a Flickr rig photo renders as `<img>` from
`live.staticflickr.com`, a SoundCloud mix renders as an `<a href>` with its title, no `<audio>`
survives) · e2e: none → **partial**

> Three named holes beyond **G1**: the `tech` subject type is the one never driven at the route;
> `apps/web/src/app/me/page.test.tsx` sets `owned.tech = null`, so the tech card and its
> `<MediaManager subjectType="tech" />` mount never render in any test; and
> `notifyUser(ownerUserId, "embed_dead")` at `media.ts:88` is never asserted — `media.test.ts` checks
> only the fraud-flag row.

<a id="t3-tech-directory"></a>
## T3. A venue or act discovers a sound tech — **important** *(actor: any signed-in)*

**Steps.** `/techs` lists live techs whose owner account is active, `createdAt` asc, limit 100
(`apps/web/src/app/techs/page.tsx:20-34`); cards show gear badge, cancellation-strike badge, bio,
labor/with-rig rates, travel radius (`:205-241`). `/t/[id]` gates on `status === 'live'` and shows the
visible-review average and strike count (`:26-38`, `:74-88`), applying the **shared** double-blind rule
filtered to payer-authored reviews (`:49-73`, `packages/domain/src/reviews.ts:32-45`). Parallel JSON at
`GET /api/techs/list` and `GET /api/techs/[id]`.

**What breaks.** No geography anywhere. Ranking is `createdAt` asc with a hard 100 cap, so the
earliest signups permanently own the top of the page and review score influences nothing. The
directory card shows the **negative** signal (cancellations) and hides the positive one (the review
average, which appears only on `/t/[id]`). And `/api/techs/list` omits the owner-active `EXISTS` clause
the page has, so it can serve a live tech whose owner is suspended — an untested divergence, on a route
with **no test file and no in-app consumer**.

**Coverage** — unit: `packages/domain/src/reviews.test.ts` (5, generic venue/performer roles);
`apps/web/src/lib/review-display.test.ts` (3 — `averageOverall` returns null, not 0, on an empty list)
· integration: `apps/web/src/app/techs/page.test.tsx` (3 — but see below);
`apps/web/src/app/t/[id]/page.test.tsx` (1, media only);
`apps/web/src/app/api/public-projection.test.ts:86-90` (tech GET never leaks `ownerUserId`) · e2e:
`e2e/sound-tech.spec.ts` visits `/techs` as the **tech looking for work**, scoped to the sound-job
panel; it never asserts on the directory and never opens `/t/[id]` → **partial**

> **⚠ vacuous.** `techs/page.test.tsx` is named for the directory and contains **zero directory
> assertions** — all three tests are about the "Gigs that need sound" panel and the header copy.
> Deleting the whole `techs.map(...)` block would fail no test in the repo. Worse, the status gate is
> a documented, shipped regression (*"setProfileVisibility wrote techs.status and nothing ever read
> it"*) and removing `eq(schema.techs.status,"live")` from the query, the `notFound()` from
> `t/[id]/page.tsx:38`, and the status clause from `api/techs/[id]/route.ts:26` breaks **zero** tests.
> `visibility.test.ts` proves the column flips; nothing proves anyone reads it.

<a id="t-messaged-directly"></a>
## T4 (=V16). A venue or act cold-messages a tech — **important** *(actor: venue)*

**Steps.** Message form on the directory card, gated on the viewer having a live venue **or** performer
profile (`apps/web/src/app/techs/page.tsx:38,242-252`). `POST /api/threads` with `techId`: venues may
message performers and techs, performers may message techs, performer→venue cold messaging stays off
(`apps/web/src/app/api/threads/route.ts:19-36`). One transaction: `lockActiveProfileOwners(techIds)`
resolves the recipient owner and rejects a self-inquiry (`:41-64`); daily cap of 10 counted by
**sender** (`:66-107`). The tech reads and replies in `/inbox`, with thread labels resolving the
"sound tech" role.

**What breaks.** A tech can **never start** a thread — the route only accepts a venue or performer as
sender — so a tech who spots an open job cannot pitch outside the formal application. And this path is
entirely off the sub-slot rails: no budget, no state machine, no ledger, no review.

**Coverage** — unit: `apps/web/src/lib/thread-display.test.ts:15-19` (a multi-role owner renders
"Sam Rivera (act / sound tech) · The Lantern (venue)"). `inquiryCreateSchema`'s exactly-one-of
refinement has **zero** tests · integration:
`apps/web/src/app/api/threads/threads.test.ts` (10 — incl. `:222` performer→tech 201, `:216`
performer→performer 403, `:316` no-profile 403, `:270` self-inquiry 409, `:228` hidden/deleted
recipient 409 with no thread row, `:113` outbox rollback atomicity);
`apps/web/src/lib/thread-profile-labels.test.ts:78-95` (a real tech row resolves to "Current Tech
(sound tech)") · e2e: **none** — grepping all six specs for `threads`, `Message` and `inbox` returns
zero hits → **partial**

> The venue→tech branch executes in exactly one test (`:172-214`) and that test asserts a **status code
> only** — nothing reads back the thread row, the two participant rows, the message body, or the
> `thread.inquiry_opened` event for a tech recipient. The 429 rate-limit branch has no test anywhere:
> raise the cap to 1000 or delete the check and the suite stays green.

<a id="t-sp-sound-plan-verdict"></a>
## T5 (=V13). The sound plan tells a booking whether it needs a tech — **core** *(actor: venue)*

**Steps.** `soundPlan(venue.paInventory, performer.techNeeds)` is computed **on read**, never persisted
on the booking (`packages/domain/src/soundplan.ts:45-110`,
`apps/web/src/app/bookings/[id]/page.tsx:242`). Four verdicts — `covered` / `unknown` / `tech_needed` /
`tech_and_rig_needed` — because **unanswered is not the same as no** (`:24-41`). Gaps are assembled
from concrete shortfalls first, then unanswered essentials appended; a known shortage outranks
uncertainty and a severe channel deficit escalates to `tech_and_rig_needed` (`:56-99`). Rendered with a
colour-coded badge in which **`unknown` is `warn`, not neutral** — rendering it in the same grey as a
settled answer hides that it is a question (`apps/web/src/lib/sound-display.ts:19-28`).

**What breaks.** The plan is recomputed on every read but **snapshotted** into a sub-slot at creation
(`packages/db/src/subslots.ts:160-170`). A venue that edits its PA afterwards changes what `/techs`
shows live while the sub-slot's frozen gaps say something else. And the verdict has no authority:
nothing blocks accepting an offer at `tech_and_rig_needed` with no sound job posted.

**Coverage** — unit: `packages/domain/src/soundplan.test.ts` (16 — all four verdicts reached, the
short-circuits pinned, and a real 9-case *"unanswered is not the same as no"* block with negative
assertions that stop the old regression re-landing);
`apps/web/src/lib/form-transforms.test.ts:85-113` · integration:
`packages/db/src/subslots.test.ts:186-198` is the **only** place `soundPlan` is reached through
production data flow — and it pins the simplest branch (`hasPA:false`) only ·
e2e: `e2e/sound-tech.spec.ts:23` asserts "Needs a tech" renders on a production build from real
profile rows → **partial**

> **⚠ vacuous ×2.** (1) `soundVerdictClass` is imported by **no test in the repo** — the deliberate
> "`unknown` is warn, not neutral" decision could be reverted to `return "badge"` and the entire suite
> stays green. (2) `needs: { verdict: "tech_needed", … }` is hand-inserted into `techSubslots` in at
> least 15 test files; every one matches a grep for "verdict" and none of them calls `soundPlan`.
> Booking-page sound assertions are all **negative** (`not.toContain("Post the sound job")`), which
> pass when the feature is deleted. And `e2e`'s `/Needs a tech/i` is a prefix of "Needs a tech and a
> rig", so it cannot distinguish the two verdicts.

<a id="t-post-sound-job"></a>
## T6 (=V14). A booking party posts a paid sound job — **core** *(actor: venue)*

**Steps.** The card renders only when `state === 'confirmed'`, `plan.verdict !== 'covered'`, the parent
is actionable and no active sub-slot exists (`apps/web/src/app/bookings/[id]/page.tsx:226-242,387-394`).
The payer select **defaults to whichever side is filling the form**, because it used to always default
to `venue` and an act's default action committed the venue to a bill (`:397-410`).
`POST /api/bookings/[id]/tech-subslot` checks party membership and `confirmed`; `createTechSubslot`
locks both profile owners and the parent booking `FOR UPDATE`, re-checks `parentIsAvailable`, applies
the single-active check plus a **partial unique index on `state in ('open','booked')`** as the
concurrency backstop, snapshots the sound plan into `needs`, and appends `subslot.created`
(`packages/db/src/subslots.ts:116-186`).

**What breaks — the finding.** **The payer predicate is set without the payer's consent.** The route
checks `isParty` only; `createTechSubslot` never checks that the actor is on the payer's side. An act
can post `payer='venue'`, and from that moment **only the venue** can book, cancel or review the job
(`apps/web/src/lib/auth.ts:224-235`) — the act cannot even withdraw the obligation it created. Nothing
tests it because nothing guards it. `budgetCents` also has a floor of 1 and **no ceiling**.

**Coverage** — unit: `packages/domain/src/soundplan.test.ts`; `ApiForm.test.tsx` (dollars→cents).
`techSubslotCreateSchema` has zero assertions · integration:
`packages/db/src/subslots.test.ts:187-250` (real profiles → real snapshot; and **exactly one**
concurrent active job with exactly one creation event);
`packages/db/src/migrations.test.ts:47-57` (the index predicate stays equal to the domain's
`ACTIVE_SUBSLOT_STATES`); `apps/web/src/app/api/bookings/[id]/tech-subslot/route.test.ts` (1 — 201 then
409 with exact copy) · e2e: `e2e/sound-tech.spec.ts:16-42` drives the real form twice →
**partial**

> Not covered at the route layer: 401, 403 non-party, 409 wrong parent state, 400 bad body. This POST
> is conspicuously **the one mutating booking route absent from `apps/web/src/app/api/authz.test.ts`**.

## T7. Sound tech finds open sound work and applies at the posted pay — **core**

**Steps.** The board query requires sub-slot open **and** booking confirmed **and** downbeat future
**and** both profiles live **and** both owner accounts active
(`apps/web/src/app/techs/page.tsx:53-92`), ordered by downbeat then creation, capped at 50 so urgent
work cannot be crowded off. Each listing carries pay, local start time with zone, input count,
house-PA state, the frozen gaps, notes, full venue address and who pays (`:141-168`). Apply is one tap
— "Apply — pay as listed". `applyToOpenTechSubslot` gates both booking owners **and** the tech, locks
the parent, re-checks availability, then locks the sub-slot and **re-reads the clock after taking the
locks**, so a request waiting on a lock cannot commit across downbeat
(`packages/db/src/subslots.ts:415-458,509-524`).

**What breaks.** Applying **is** agreeing — there is no counter-offer phase. And a second, **public,
unauthenticated** feed at `GET /api/tech-subslots` returns every `open` sub-slot with **no filter** on
parent state, downbeat, profile status or owner status — including the venue's full street address
(`apps/web/src/app/api/tech-subslots/route.ts:9-32`). It contradicts the `/techs` page's gating and has
no test file.

**Coverage** — unit: `packages/domain/src/subslot.test.ts` · integration:
`apps/web/src/app/api/tech-subslots/[id]/applications/route.test.ts` (2 — apply-once/withdraw-while-
pending; 403 no profile, 409 not open, 401 anon); `packages/db/src/subslots.test.ts:386-460` (atomic
apply/withdraw/book lifecycle), `:461-516` (**no apply when the request waits across downbeat**),
`:690-718` (rejects after parent close with no row and no event);
`apps/web/src/app/techs/page.test.tsx:141-160` (only future open work on a confirmed active gig is
listed); `apps/worker/src/notify-routing.test.ts:396-450` · e2e:
`e2e/sound-tech.spec.ts:62` (the tech discovers two jobs with pay visible and applies to each) →
**partial**

## T8. Sound tech withdraws a still-pending application — **important**

**Steps.** The control renders only when the application is `submitted`, the job is actionable and the
account is active (`apps/web/src/app/sound/[id]/page.tsx:199-218`).
`DELETE /api/tech-subslots/[id]/applications` deletes only a row still in `submitted` and appends
`subslot.application_withdrawn`; distinct 404 (never applied) and 409 (already answered)
(`packages/db/src/subslots.ts:614-659`).

**What breaks — the finding.** The withdrawal **DELETEs the row** rather than marking it. The tech's
own "Sound work" list is driven entirely by `techSubslotApplications`
(`apps/web/src/app/bookings/page.tsx:90-112`), and `/sound/[id]` access keys off the same row, so the
tech loses the job completely and the page 404s for them. There is no record they ever engaged.
Consequently the status `withdrawn` is **unreachable** for sound jobs — and the UI branch
(`apps/web/src/lib/sound-display.ts:143-144`), the label (`labels.ts:34`) and the tests that cover them
(`sound-display.test.ts:167-190`, `sound/[id]/page.test.tsx:199-237`, which manually `UPDATE`s a row to
`'withdrawn'`) all describe a state the system cannot produce. The payer is never notified either.

**Coverage** — unit: `apps/web/src/lib/sound-display.test.ts` (of an unreachable state) · integration:
`apps/web/src/app/api/tech-subslots/[id]/applications/route.test.ts:123`;
`packages/db/src/subslots.test.ts:386-460` · e2e: none → **partial**

<a id="t-payer-books"></a>
## T9 (=V15). The paying side selects an applicant and books the tech — **core** *(actor: venue)*

**Steps.** The applicant list is visible **only to the payer**
(`apps/web/src/app/sound/[id]/page.tsx:118-129`); each Book control is gated by
`isSoundApplicantBookable` — job actionable, application submitted, tech profile live, tech owner
active (`apps/web/src/lib/sound-display.ts:85-94`). `bookTechApplicant` takes a **per-tech advisory
xact lock** and rejects any positive interval overlap with another booked job, allowing exact
end/start adjacency (`packages/db/src/subslots.ts:460-490`). The ledger charge is **version-keyed** so a
reopened-then-rebooked job charges again (`:292-302`). Losing applicants are flipped to `declined`,
each with its own addressed event (`:581-624`).

**Coverage** — unit: `packages/domain/src/subslot.test.ts:21-27` + the exhaustive state×event table at
`:102-119` · integration: `apps/web/src/app/api/tech-subslots/[id]/book/route.test.ts` (5 — refuses the
non-paying side of the same booking and changes nothing; refuses a stranger; books the pending
applicant and truthfully closes the loser; an actionable conflict **preserving** the application on an
overlapping gig; 404 when the tech never applied); `packages/db/src/subslots.test.ts:251-299`
(positive overlap rejected, exact adjacency allowed), `:300-342` (concurrent overlapping selections
serialised), `:343-367` (exactly one charge row; re-running rejected), `:517-587` (no booking when the
request waits across downbeat) · e2e: `e2e/sound-tech.spec.ts:62` books one of two overlapping gigs and
asserts the other returns `tech_unavailable` **and preserves the pending application** →
**partial**

> Everything the payer can see and everything the database enforces is locked down; the half that
> **leaves the system** — telling the winner — is unprotected. The `to:"both"` fan-out for
> `subslot_booked` is never driven, and `subslot_booked` links to `/bookings` rather than
> `/sound/{subslotId}` (`apps/worker/src/notify.ts:133-136`), so the tech's confirmation email does not
> deep-link the room specs and day-of contacts it advertises.

## T10. Booked tech gets load-in details and day-of contacts — **important**

**Steps.** Access to `/sound/[id]` is booking party, assigned tech, or applicant — otherwise
`notFound` (`apps/web/src/app/sound/[id]/page.tsx:89-101`). Operational detail (full venue address, PA
channel/mic/monitor counts, notes) is revealed to parties, the assigned tech, or while the job is still
actionable (`:102-103,166-196`). **Day-of contacts** load only when `state === 'booked'` and the viewer
is a party or the assigned tech (`:131-146,294-305`).

**What breaks.** Contacts are gated on `state === 'booked'`, so the moment the parent releases the tech
loses the venue's and act's phone numbers — exactly when a "you left a mic here" call happens. The
tech's booked work **never appears in the iCal feed**: `/api/calendar` is built from
`performerOwnedBy`/`venueOwnedBy` and bookings only. There is no day-before reminder template for a
tech. And a load-in time distinct from downbeat cannot be expressed anywhere but free-text notes.

**Coverage** — unit: `apps/web/src/lib/sound-display.test.ts:191-220` (a stale selected assignment is
not described as active work) · integration: `apps/web/src/app/sound/[id]/page.test.tsx` (3 — stale
application controls and operational details removed immediately; truthful withdrawn/declined/closed
outcomes; tech cancellation hidden after parent close or downbeat);
`apps/web/src/app/bookings/page.test.tsx` · e2e: `e2e/sound-tech.spec.ts:163` asserts the tech sees
"You are booked" → **partial**

> The **Day-of contacts card has no assertion at any layer** — and it is the journey's actual payload.

## T11. Sound tech cancels a booked job — **important**

**Steps.** The control renders only when state is `booked`, parent `confirmed` and future, both
profiles live and both owners active (`apps/web/src/lib/sound-display.ts:97-105`).
`POST /api/tech-subslots/[id]/cancel` routes on `isBookedTech` → `TECH_CANCELLED` with an
`expectedTechId` so a replacement tech's booking cannot be cancelled by a stale request.
`runSubslotTransition` pre-checks the parent under lock then **re-reads the clock after taking the
sub-slot lock** (`packages/db/src/subslots.ts:200-238`). The job returns to `open`, `techId` clears, the
payer is refunded in full, and a reliability strike lands. Stale applications are **DELETEd inside the
same transaction** — this used to run after commit and left techs permanently told "You've already
applied" to a reopened job (`:277-287`).

**What breaks.** The cancellation deletes every application **including the cancelling tech's own
booked row**, so the tech loses all trace of the job — including the contact details they might need to
hand off. Past downbeat, `TECH_CANCELLED` is refused, so a tech whose van dies at 6pm has no in-product
way to signal it; the job stays `booked` with nobody coming. The strike is permanent, uncapped, undecayed
and context-free, and it **also fires on account-exit wind-down** — a tech who quits is scored for it.

**Coverage** — unit: `packages/domain/src/subslot.test.ts:56-66` · integration:
`apps/web/src/app/api/tech-subslots/[id]/cancel/route.test.ts` (2);
`packages/db/src/subslots.test.ts:368-385` (full refund and reopen), `:719-781` (no reopen after parent
close), `:782-830` (no reopen when the request waits across downbeat);
`apps/web/src/app/sound/[id]/page.test.tsx:238` · e2e: none → **partial**

> The stale-application cleanup at `subslots.ts:283-287` is a **shipped regression with no guard**: the
> delete block can be removed with the whole suite green.

## T12. The sound job closes under the tech — **important**

Payer cancellation stays available even post-downbeat and post-suspension so the obligation can be
closed and settled directly (`apps/web/src/lib/sound-display.ts:107-131`). `booked` + `PAYER_CANCELLED`
or `PARENT_CANCELLED` applies `venueCancellationFee` — the tech is protected by the same schedule as
the act (`packages/domain/src/subslot.ts:102-120`). `open` + `PARENT_CANCELLED` closes quietly. The
worker cascades parent cancellations onto every active sub-slot
(`apps/worker/src/index.ts:615-628`), and every still-submitted application is flipped to `declined`
with an addressed notice.

**What breaks — the finding.** **The protection is notional.** With payments off, the fee is a ledger
row nobody settles — and the discovery-mode copy the tech actually receives says "No platform money is
in play" and tells them to sort it out directly (`apps/worker/src/notify.ts:227-232`). A tech cancelled
on 24 hours' notice has an entitlement recorded and no mechanism behind it.

**Coverage** — unit: `packages/domain/src/subslot.test.ts:34-55` (PARENT_CANCELLED inside 48h → 100% to
the tech; PAYER_CANCELLED in the 48h–14d window → 50/50) · integration:
`packages/db/src/subslots.test.ts:588-689`; `apps/worker/src/cascade.test.ts` (2);
`apps/worker/src/notify-routing.test.ts:396-450` · e2e: none → **partial**

> The payer's own cancellation — the journey's actual trigger — has **no route test at all** for the
> payer path: the `refundCents > 0` branch and its `refund:fee:{version}` idempotency key have never
> been executed by any test.

## T13. The gig happens and the sound job releases — **important**

The worker cascades **every** parent outcome that means the night happened — `released`, `refunded`
**and** `partially_released` — so a disputed booking never strands its tech
(`apps/worker/src/index.ts:615-625`). The release ledger row is credited to `tech:<id>` and keyed
**non-version** so it cannot double-pay (`packages/db/src/subslots.ts:303-311`).

**What breaks.** **Only the tech is notified** (`to: 'tech'`), so the payer is never told the review
window opened — and there is no review-prompt job for sound jobs at all (the review queue is
booking-only). Techs also have **no payout rail** even when payments turn on: performers carry
`stripeAccountId`, techs do not. The ledger credits an account that cannot receive money.

**Coverage** — unit: `packages/domain/src/subslot.test.ts:28-33` · integration:
`apps/worker/src/cascade.test.ts` (2 — both `refunded` and `partially_released` parents release the
booked tech rather than stranding them); `packages/db/src/subslots.test.ts:343-367` · e2e: none →
**partial**

> The **release ledger row has zero row-level assertions at any layer** despite being the thing the
> tech is paid by, and the `${subslotId}:release` key is the only one without a version suffix — the
> one place a genuine idempotency regression is possible.

## T14. Payer and tech review each other — **important**

Form renders only at `state === 'released'`, for a viewer with a review role who has not already
reviewed (`apps/web/src/app/sound/[id]/page.tsx:105-117,270-292`); the `(subslot, authorRole)` unique
index turns a double submit into a 409; the public tech page applies the **shared** double-blind rule
rather than a local copy that used to shadow the domain export
(`apps/web/src/app/t/[id]/page.tsx:58-73`).

**What breaks — the finding.** **The loop is half-open.** The tech's review of the payer is written and
rendered **nowhere** — `/t/[id]` filters to `authorRole 'payer'`, and no venue or act page reads the
table at all. The tech's review exists only to unlock the payer's review early. Nobody is ever prompted
to review a sound gig. Ratings are `{overall}` only, so mix quality, punctuality and gear condition —
the things that distinguish engineers — are not captured. And a job that ends any way other than
`released` produces no review from anyone.

**Coverage** — unit: `packages/domain/src/reviews.test.ts` (generic roles only) · integration:
`apps/web/src/app/api/tech-subslots/[id]/review/route.test.ts` (3 — one review from each side;
rollback when the outbox event cannot be appended; outsiders and pre-completion reviews rejected) ·
e2e: none → **partial**

> Flipping `"payer"` to `"tech"` at `t/[id]/page.tsx:73` would publish the tech's reviews **of payers**
> on the tech's own profile, and the suite stays green.

## T15. Sound tech leaves, or an admin suspends them — **important** *(actor: admin)*

`setProfileVisibility` walks performers → venues → techs in a fixed order
(`packages/db/src/account.ts:59-62`). Deactivation reads the tech's booked sub-slots and cancels each
via `TECH_CANCELLED` with `expectedTechId`, inside the account-exit transaction (`:359-404`); pending
applications are withdrawn in the same transaction; rows that moved are skipped rather than aborting
the exit. Discovery drops them immediately.

**Coverage** — unit: `apps/web/src/lib/profile-capabilities.test.ts` · integration:
`packages/db/src/account.test.ts:167,334,398`; `packages/db/src/account-suspension.test.ts:328-400`;
`packages/db/src/visibility.test.ts:79-95`; `apps/web/src/lib/sound-display.test.ts:133-166` · e2e:
`e2e/account-lifecycle.spec.ts` (2 — venue and performer arms only, **no tech arm**) → **partial**

> The wind-down fires `TECH_CANCELLED`, which unconditionally applies a strike — a tech who quits the
> platform is scored for it, and the strike survives restoration. Nothing enforces the PRD's "repeated
> late cancels → suspension": `reliabilityStrikes` is a display-only counter with no threshold logic
> anywhere in the codebase.

## T16. **DORMANT** — a sound tech is charged for, held, and paid out through EightGig

The full money vocabulary exists (`subslot_charge`, `subslot_release`, `subslot_fee`,
`subslot_refund` — `packages/domain/src/subslot.ts:44-48`) and ledger rows are written for all of them
with per-version idempotency keys. But `paymentsEnabled()` requires **both** the flag and a Stripe key,
and infra pins `PAYMENTS_ENABLED='false'` (`infra/cdk/lib/gigit-stack.ts:150`). As the module states,
*"with the Null gateway the ledger IS the execution"*.

Two things make this more than dormant-but-ready: techs have **no `stripeAccountId` column at all**, so
the ledger credits `tech:<id>` to an account that cannot receive money; and **no sub-slot money effect
is ever handed to the gateway** — the worker's money dispatch handles booking subjects only. Turning
payments on would light up bookings and leave sound jobs ledger-only.

**Coverage** — `packages/db/src/payments.test.ts:15`; `packages/db/src/ledger.test.ts`;
`packages/db/src/subslots.test.ts:343-367` → **dormant**

---

# 4. Admin / ops

Twenty journeys. This is the best-covered actor by verdict count (7 covered) and also holds the
document's only **uncovered** journey — the one that pages a human when the fan-out is wedged.
Two are dormant.

The through-line: **what ops decides is well tested; what ops sees, and whether ops is told, is not.**

## O1. Ops grants itself access — the first admin — **core**

**Steps.** A fresh environment has no `actor_roles` row with `kind='admin'`, so every `/admin` surface
answers "Admin only". An operator runs `scripts/seed-admin.cjs` on a host with `DATABASE_URL`; `:31`
lowercases the email so it agrees with the unique index on `lower(email)` that sign-in uses; `:47`
finds or creates the user; `:66` is the idempotent re-run guard; `:74` inserts the role and `:81`
appends the audit event. `isAdmin()` reading `actor_roles` is the **only** definition of staff
(`apps/web/src/lib/auth.ts:164`); `adminUserId()` gates pages by returning null, `requireAdmin()` gates
`/api/admin/*` by throwing a 403; `AdminOnly.tsx:12` renders a sign-in card so a teammate following a
pasted ops link gets a way in rather than an error boundary.

**What breaks.** Zero admin rows means escalations pile up unread, nobody can suspend anyone, and the
dashboard is dark — `scripts/seed-admin.cjs:5-9` records that production was in exactly this state.
There is no in-product path to promote a user, so losing the admin means losing ops until someone
re-runs a container by hand. Admin is a single flat role: anyone who can read the support queue can
also suspend accounts.

**Coverage** — unit: none — `isAdmin`/`requireAdmin`/`adminUserId` have no direct unit test ·
integration: `apps/web/src/app/admin/admin-page-gates.test.tsx:46` parameterises **all 7 admin pages ×
(signed-out / non-admin / admin) = 22 real gate assertions**. The bootstrap script itself: **verified,
no test file anywhere references it** · e2e: `e2e/post-gig.spec.ts:145` and
`e2e/account-lifecycle.spec.ts:83` sign in as a seeded admin — but the role comes from the test seeder,
not the bootstrap script → **partial**

> Weakest: run `seed-admin.cjs` twice against a real DB with a `Mixed.Case` address and assert exactly
> one `actor_roles` row exists and that `sessionUserId` for the lowercase form resolves to
> `isAdmin() === true`. The lowercasing at `:31` and the idempotent guard at `:66` are asserted nowhere.

## O2. The outbox drains: every committed event becomes its real-world side effect — **core**

**Steps.** The drain loop claims up to 50 due, undispatched, un-dead-lettered rows with
`for update skip locked` (`apps/worker/src/index.ts:302`), then dispatches and marks **per row**, so a
throw on one neither rolls back the others nor wedges the head (`:314-315`). `schedule` effects become
pg-boss jobs keyed `${bookingId}:${job}` (`:398`); `request_payment` re-reads the booking and refuses
to charge past downbeat (`:414`); `notify` fans out by `subject_type` (`:463`); money effects hit the
gateway (`:500/:516/:531`). One customer notice is allowed through the suspended-account boundary and
only one — it requires `kind='user.suspended'` **and** `payload.commitmentsWoundDown === true` (`:547`).
On failure: `attempts++`, `last_error`, exponential backoff (2s·2ⁿ capped at 1h), dead-lettered at 5 so
the head advances (`:321-349`).

**What breaks.** A dead-lettered row is parked forever: there is no replay tool and no ops UI for dead
letters anywhere in `apps/web` — recovery is hand-written SQL on the box, and a parked
`support.escalated` is a customer nobody ever answers. At-least-once means duplicates on any retry
after an external send; mitigations are **hand-placed per handler** (`index.ts:222` marks
`slot.reengaged` before notifying; `:601` sends the act welcome last) and each new handler must
re-reason about it. `index.ts:498` logs `notify.unrouted` for an unhandled subject type: the event
dispatches successfully and the notification silently never happens.

**Coverage** — unit: none (dispatch is I/O by construction) · integration: **strong** —
`apps/worker/src/outbox.test.ts:49/:65/:81` (poison isolated while the good row still dispatches;
backoff honoured before retry; parked at the attempt cap so the head advances) +
`dispatch-effects.test.ts` (9 — release/refund/charge routing, replay with the same operation key,
same-amount transfers kept distinct at the gateway seam, `cancellation_fee` split, the late-charge skip
at downbeat) + `notify-routing.test.ts` (11) + `cascade.test.ts` (2) + `review-prompt.test.ts` (3) +
`support-notification.test.ts` (5) · e2e: implicit but real —
`e2e/booking-journey.spec.ts:192-204` waits for the **Confirmed** badge produced by the actual worker
draining actual rows → **covered**

> Caveat: no test imports `main()`, so the claim query itself — `for update skip locked`, `LIMIT 50`,
> the due/undispatched/un-dead-lettered predicate at `index.ts:302` — is only exercised where tests
> call `drainOutboxOnce` directly. Nothing proves two concurrent drainers claim disjoint row sets.

## O3. Ops is paged when the fan-out is wedged or a message was abandoned — **core** — **UNCOVERED**

**Steps.** The reconcile loop's health block reads `outboxLagMs()` (`apps/worker/src/index.ts:781` →
`packages/db/src/reconcile.ts:106`), logs `outbox.LAGGING` and captures to Sentry above 5 minutes
(`:782`), counts dead-lettered events (`:786`), and publishes `OutboxLagMs` and `DeadLetteredEvents` via
`putMetrics` (`:794`) — which no-ops unless `GIGIT_STAGE` is set (`:831`), the guard that keeps local
and test runs off CloudWatch. `OutboxDeadLetterAlarm` fires at ≥1 on the first breach
(`infra/cdk/lib/gigit-stack.ts:648`); `OutboxLagAlarm` above 10 minutes (`:678`). `:798` swallows every
error in the health block — *"health check must never kill the loop"*.

**What breaks.** Rename a metric in the worker and the alarm keeps watching the old name in
`INSUFFICIENT_DATA` — nothing ties the two strings together and the infra test still passes. Sentry is
gated on `SENTRY_DSN`, which is unset in production, so every `captureMessage` in the worker is a
no-op and CloudWatch is the only real channel. And because `:798` swallows everything, a health check
that throws on every pass is completely invisible.

**Coverage** — unit: none · integration: **none on the emitting side. Verified: the only test file in
the repo mentioning `putMetrics` / `outboxLagMs` / `DeadLetteredEvents` is
`infra/cdk/test/infrastructure-guarantees.test.ts`, which asserts the CONSUMING side** (alarm watches
the right metric name, right stage, fires on first breach) · e2e: none → **uncovered**

## O4. Scheduled timers move bookings nobody touched — **core**

**Steps.** `index.ts:398` arms; `:116` the booking-timers worker calls `fireTimer`; `:261` runs the
transition as actor `worker`; `:272` treats `IllegalTransition` / `BookingNotFound` /
`ConcurrentUpdate` as **benign no-ops** — a stale timer on a booking that already moved is expected,
not poison. `:123` the reminder queue re-checks the booking is still `confirmed` before sending
(`:129` logs `reminder.stale`). `:142` the review queue asks `pendingReviewAudience` and nags only the
side that still owes a review. `:411` `cancel_schedule` is deliberately a no-op — staleness is handled
at fire time, not by cancelling jobs.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts:83` (exhaustive state×event covering
`OFFER_EXPIRED` / `GIG_ENDED` / `AUTO_CONFIRM_ELAPSED`), `:158`, `:168`;
`machine.property.test.ts:61` (random sequences never escape the state set) · integration:
`packages/db/src/transition.test.ts:307/:333/:345` (TTL clamped so an offer never outlives its gig),
`:937` (offer expiry returns the stranded application to `submitted`);
`apps/worker/src/review-prompt.test.ts:105` (asserts the 24h delay **and** the singleton dedup);
`reconcile-loop.test.ts:154` (re-arms a lost gig-end timer) · e2e:
`e2e/aged-slot.spec.ts` and `e2e/post-gig.spec.ts` drive past-dated bookings from seeded fixtures —
**no spec waits on a real pg-boss timer to fire** → **partial**

> What the timer **does** is exhaustively covered; that it is **armed and fires correctly** is covered
> only for the review prompt. The day-before reminder's staleness re-check at `index.ts:123-129` has no
> test at all. `fireTimer`'s deliberate benign-error swallow at `:272` is also unasserted, so a change
> that turned a stale timer into poison would dead-letter in production, not in CI.

## O5. The reconcile sweep re-derives what a lost dispatch dropped — **core**

**Steps.** Every 10 minutes plus once at loop start, `reconcileOnce()` reads every booking in
`offered` / `confirming` / `confirmed` / `awaiting_confirmation` (`apps/worker/src/index.ts:704-709`).
For `confirming`: if downbeat has passed it fires `PAYMENT_FAILED` with reason
`payment_window_closed` — **downbeat is the hard deadline, not the generic timeout** (`:726`);
otherwise it uses `performer_accepted_at` falling back to `created_at` and fires `payment_timeout`
after `AUTO_CONFIRM_HOURS` (`:741`). `:756` re-derives overdue `OFFER_EXPIRED`, `GIG_ENDED` and
`AUTO_CONFIRM_ELAPSED`.

**What breaks.** Only four states are swept. A booking wedged in any other state — notably
`disputed` — is invisible to the sweep and waits on a human forever. The sweep's errors are only
logged, and no metric is emitted for sweep failures.

**Coverage** — unit: none needed (pure re-derivation from persisted state) · integration:
`apps/worker/src/reconcile-loop.test.ts` (6, driving the exported `reconcileOnce` against real
bookings: collapse past the payment timeout `:100`; leave one still inside the window `:116`; close a
pending payment at downbeat even inside the generic timeout `:125`; still drain a `confirming` booking
with no recorded acceptance, i.e. the `created_at` fallback `:141`; re-arm a lost gig-end timer and
auto-confirm an overdue night `:154`; leave a future night alone `:170`) · e2e: none directly →
**covered**

> `reconcileOnce` was exported specifically so this was testable — the rare case of a design change made
> **for** coverage. Residual hole: the interval at which the sweep runs is unverified, shared with **O19**.

## O6. An escalated support message lands in a human's inbox — **important**

**Steps.** Anonymous submissions are rate-limited per-IP and globally and **always** escalate
(`apps/web/src/app/api/support/route.ts:46-64`); signed-in messages go through `supportTriage` and
escalate at `:98`; a triage **throw** escalates as `triage_error` at `:83`. SMS has three equivalent
paths. With no model configured **everything escalates** — honest over clever
(`packages/db/src/ai.ts:601`). `createSupportRequest` writes the request row and the
`support.escalated` event in **one** transaction, backfilling contact email/phone from the user row.
The worker routes it to `notifySupportOperator`, which in production **throws** when the mailbox or
sender is unconfigured so the outbox retries and dead-letters loudly rather than dropping the handoff
(`apps/worker/src/notify.ts:466-470`). The worker also boots with a loud, every-restart error log when
`SUPPORT_EMAIL_TO` or `EMAIL_FROM` is blank, because the CDK-provisioned `AppSecrets` starts blank.

**What breaks.** Production with a blank `SUPPORT_EMAIL_TO`: every escalation burns 5 attempts and
dead-letters, after the requester was told "a person will get back to you". The escalation email
carries only the request id and links behind the admin gate, so it is useless to anyone who is not
already an admin — which loops back to **O1**. `SUPPORT_EMAIL_TO` is the entire routing table: no
per-category routing, no on-call rotation, no second channel.

**Coverage** — unit: `packages/db/src/env.test.ts:10` (rejects undefined/empty/whitespace
`SUPPORT_EMAIL_TO`), `:31` (a malformed one) · integration:
`apps/web/src/app/api/support/route.test.ts` (6 — anonymous submissions escalate and consume a per-IP
quota; signed-in and SMS escalations do **not** consume the public quota; an authenticated escalation
persists with a contact snapshot; **a triage throw becomes a durable escalation rather than a lost
message**); `apps/web/src/app/api/webhooks/twilio/route.test.ts:234`;
`apps/worker/src/support-notification.test.ts` (5 — routed to the log sink in test, stays retryable
when prod config is missing, stays retryable when SES rejects, actually reaches SES when configured) ·
e2e: none → **covered**

> Unusually complete for an ops path: both halves — the durable row and the operator email — fail
> loudly under test, and the "production throws so the outbox retries" decision is directly asserted
> rather than assumed. Untested seams: the legacy-subject derivation (`spr_legacy_` at `index.ts:607`)
> and the every-restart boot warning at `:89`.

## O7. An admin claims, annotates and resolves a support request — **important**

**Steps.** `/admin/support` lists open (default) or resolved, oldest-first for open, 100 max; the reply
contact is picked by channel (**SMS-first for texts**). Claim uses a **conditional UPDATE**
(`status='open' AND claimed_by IS NULL`) so a two-admin race is safe, the loser getting 409 "Someone on
the team already picked this up"; a `claim` note and `support.claimed` event commit with it. Note-add
takes a **row lock specifically to serialise against resolve**, so a note can never land after the
request closed. Resolve requires `status='open' AND claimed_by = this admin` — **only the claimant
closes it** — with a mandatory resolution note.

**What breaks.** Resolving is a promise, not a delivery: the product never sends the reply. An admin
can close a request having emailed nobody and nothing detects it. There is no unclaim, no reassign, no
SLA and no age surfacing — an admin who claims and goes on holiday parks it permanently, since the
claim gate means no one else can close it. The queue is capped at 100 with no pagination.

**Coverage** — unit: none — the `SupportCaseActions` visibility rules at `:85/:88/:100` are pure and
untested · integration: `apps/web/src/app/api/admin/support/support-actions.test.ts` — exactly **2**
tests: (a) auth + admin role + missing-request handling, (b) one **sequential** walk of claim → note →
claimant-only resolve → immutable closure · e2e: **none** — no spec ever opens `/admin/support` →
**partial**

> The conditional UPDATE exists **only** for a two-admin race and is never driven concurrently, so the
> 409 is proven by a second sequential call, not by the race it was written for. The row lock taken to
> serialise a note against a concurrent resolve is likewise untested.

## O8. A moderator clears or upholds a held media link — **important**

**Steps.** `/admin/moderation` lists open flags by confidence desc, 100 max, rendering the raw evidence
JSON. `POST /api/admin/flags/[id]/resolve`: `requireAdmin`, 404 unknown flag, 409 already resolved,
then clear → `held` becomes `ready` (**the link publishes**) or uphold → `blocked`, recorded under the
admin's id as `flag.cleared` / `flag.upheld`.

**What breaks.** The moderator **decides blind**: for an `ai_screen` flag the evidence is only
`{reasons}` — no link to the URL, the embed title, the owner or the profile. Clearing a second flag on
an already-blocked asset closes the flag and leaves the asset blocked with no UI signal. The owner is
**never told** their link was held or blocked. And if the AI gateway is unconfigured or throws,
`screenMedia` throws inside the outbox handler, so links silently stop publishing and rows dead-letter.

**Coverage** — unit: none · integration:
`apps/web/src/app/api/admin/flags/flag-resolve-media.test.ts` (2 — clearing releases `held` → `ready`;
upholding sets `blocked` without violating the post-0033 CHECK constraint);
`apps/worker/src/media.test.ts:76/:84/:106` · e2e: none → **partial**

> **The two column writes are asserted; the point of the queue is not.** Upholding a flag is proven to
> change a status value and nothing else, because no test anywhere renders a public page with a
> non-`ready` asset — `p/[id]`, `v/[id]` and `t/[id]` page tests all hardcode `status:"ready"`. So
> **`blocked` has no observable meaning in the suite** (gap **G1**). Also unasserted: the 409 on an
> already-resolved flag, the 404 on an unknown flag, the confidence-desc ordering, and that
> `flag.cleared`/`flag.upheld` carry the acting admin's id — the audit trail the whole moderation story
> rests on.

## O9. An admin suspends an account and its commitments wind down — **important**

**Steps.** One transaction: `SELECT … FOR UPDATE` on the user row is the **shared creator gate** —
work committed before it is swept, work attempted after it observes `suspended` and cannot be created
(`packages/db/src/account.ts:464-470`). `windDownAccountCommitments` cancels/reopens future bookings,
closes open slots and pending applications, reopens booked sound sub-slots **through the real state
machine**, and withdraws pending tech applications (`:481`). Then `users.status` flips and
`setProfileVisibility(userId,'suspended')` runs **in the same transaction**, because a venue's street
address must not stay public for a moment longer (`:489-493`). `user.suspended` is appended with
`payload.commitmentsWoundDown=true` — that exact marker is what lets the notice through the
inactive-account boundary (**O2**). The bite: `assertAccountActive` rejects suspended sessions on every
authenticated surface **including the signed-token iCal feed** (`apps/web/src/lib/auth.ts:94`).

**What breaks.** Highest-blast-radius button in the product, one click, **no confirm dialog and no
reason field** — the events row records who, never why. Wind-down runs inside the suspension
transaction, so a data anomaly on one booking blocks moderating the account at all (deliberate, but it
means the lever can jam). Suspension does not reach anyone the account already met.

**Coverage** — unit: `apps/web/src/lib/profile-capabilities.test.ts:8/:19` · integration: **the
strongest ops journey.** `apps/web/src/app/api/admin/users/[id]/status/route.test.ts` (9 — winds down
active work and does not resurrect it on reinstate; restores current profiles without reviving older
hidden ones; reactivates exactly one deterministic legacy profile per type; **rolls back account AND
profiles when the audit event cannot commit**; refuses a deleted account);
`packages/db/src/account-suspension.test.ts` (5 — performer/venue/tech wind-down with post-gig and
disputed records retained, reopened sound work, a payment success arriving after suspension collapsed
`confirming` being compensated, legacy repair exactly once, **the creator gate sweeping work committed
before it and rejecting work after**); `packages/db/src/visibility.test.ts:1030`;
`apps/worker/src/notify-routing.test.ts:275` (delivers **only** the exact essential suspension event to
a suspended account) · e2e: `e2e/account-lifecycle.spec.ts:35` drives it against a production build →
**covered**

> The single unasserted bite: `assertAccountActive` is split out of `requireUser`
> (`auth.ts:85-93`) **precisely so the signed-token iCal feed re-checks status**, and no test suspends
> an account then re-fetches its calendar feed (gap **G10**).

## O10. An admin reinstates a suspended account — **important**

**Steps.** The route opens its own transaction, locks the user row, and returns `unchanged` /
`not_found` / `invalid_transition` — **a deleted account can never be reinstated here** (409). It sets
`status='active'`, calls `setProfileVisibility(userId,'live')` to restore the **current** profiles
without resurrecting older hidden ones, and appends `user.active`. The deliberate boundary:
reinstatement restores public presence, **never the commitments the suspension closed**.

**What breaks.** The reinstated user's cancelled bookings, closed slots and withdrawn applications are
gone for good, nothing tells them why their calendar is empty, and reinstatement **sends no
notification at all**. Reinstate is a separate code path from suspend (an inline transaction in the
route rather than a service in `packages/db`), so the two directions can drift; only the route test
holds them together.

**Coverage** — unit: none · integration:
`apps/web/src/app/api/admin/users/[id]/status/route.test.ts:51` (suspend→reinstate round trip), `:141`,
`:266`, `:471` (**does not reactivate a deleted account or republish its hidden profiles**);
`packages/db/src/visibility.test.ts:991` · e2e: none — `account-lifecycle.spec.ts` suspends, then the
owner self-deactivates; it never reinstates → **covered**

## O11. An admin decides what happened on a disputed night — **important**

**Steps.** `/admin/disputes` lists every booking in `disputed` with both party names and digs the
`DISPUTE_OPENED` payload out of the transition events to show who reported it and why. Exactly two
decisions are offered — "Close as played" (`release_full`) and "Close as not played" (`refund_full`) —
each requiring an explicit responsible side (venue / performer / neither). A `partial` resolution is
additionally checked to sum to the booking amount **before** it reaches the machine. The reducer emits
a `reliability_strike` when fault is not `neither`; the transition runner writes the ledger intent and
increments the strike counter in the same transaction; the outbox cascades the outcome into any booked
sound sub-slot so the tech is not stranded, arms the review prompt, and notifies both sides.

**What breaks.** `disputed` has exactly one exit and it is a human: no timer, no sweep, no escalation
touches it, and the only place it is visible as a number is the dashboard's "Disputed (a person needs
to look)" row. The admin never sees the other side's account — only the reporter's reason. A strike is
permanent and silent, with no notification and no path to reverse it. And once resolved the report
disappears with no resolved view.

**Coverage** — unit: `packages/domain/src/booking/machine.test.ts:235-306` (partial split must conserve
the total; negative legs rejected; non-integer legs rejected **even when they sum**), `:137`
(fault → `reliability_strike`); `packages/domain/src/reliability.test.ts` (6) · integration:
`apps/web/src/app/api/admin/admin-money.test.ts:155-204` (403 non-admin; `release_full` producing a
full-release ledger row; a partial that doesn't sum → 422; resolving a non-disputed booking → 409);
`packages/db/src/transition.test.ts:1208`; `apps/worker/src/cascade.test.ts:137/:151`;
`apps/web/src/app/api/bookings/[id]/postgig.test.ts:152/:185` · e2e: `e2e/post-gig.spec.ts:78` drives
the whole arc against a production build: open a dispute, admin reads the reported reason, closes as
played, both sides then review → **covered**

> Real gap on the reliability side: nothing asserts that `DISPUTE_RESOLVED` with a fault actually
> increments `performers.reliability_strikes` / `venues.reliability_strikes`
> (`packages/db/src/transition.ts:459-468`). The reducer's *emission* is unit-tested and the
> cancellation path's strike is integration-tested; the **dispute path's write is not**, so a fault
> verdict that recorded no strike would pass.

## O12. An admin asks the AI to draft an adjudication — **peripheral**

**Steps.** `disputeBrief` pulls the booking's first 100 events and fences them as untrusted DATA. The
system prompt is **payments-aware**: with payments off it must propose a non-monetary resolution and
must never name a dollar amount or the deferred fee split (`packages/db/src/ai.ts:641`). The task is
logged with status `needs_review` — the AI drafts, a human decides. With no model configured the page
says so and points ops at the raw event log via ops search.

**What breaks.** `ai.ts:656` never checks the booking exists or is disputed: any bookingId produces a
brief from an empty event log. There is no cache, so every page load re-bills a model call.

**Coverage** — unit: `packages/db/src/ai.test.ts` (2 — the prompt is non-monetary with payments off and
carries amounts + the fee schedule with them on); `packages/db/src/ai.eval.test.ts:104-152` (prompt
fencing **with no API key needed**: user text cannot close the fence it sits in, cannot open a tag of
its own, attribute-bearing fences stay intact, empty/nullish input doesn't break the fence) ·
integration: only the gate. The golden and injection evals at `:15-81` are key-gated and skip in CI
(`testing.md` QA-07 still open) · e2e: none → **partial**

> The compliance-critical half **is** pinned. The page's own behaviour is not — and since no model is
> configured at launch, **the only branch that runs in production is the untested one**: the no-model
> fallback at `dispute-brief/page.tsx:27-34`.

## O13. Ops reads whether the marketplace is working — **important**

**Steps.** `/admin` computes nine aggregates on every load: fill rate; **median** time-to-fill via
`percentile_cont` — deliberately not `avg()`, because time-to-fill is heavily right-skewed and the old
mean overstated the wait; applications per **slot** with drafts excluded and empty slots counted as the
zeroes they are (grouping by `slot_id` had made the figure read healthiest exactly when supply was
failing to show up); booking states including "Disputed (a person needs to look)"; ledger totals
relabelled when payments are off; the activation funnel; and signup attribution from
`events.payload`.

**What breaks.** Every number is all-time with no date range, no trend and no per-metro split: a market
that stopped working three weeks ago still shows a healthy lifetime fill rate. The metrics are computed
inline in JSX-adjacent code, so the definitions cannot be reused or compared anywhere — and the two
that **were** wrong were both silent and both flattering. "Disputed" is the only ops-queue depth on the
page: unclaimed support requests, open moderation flags, dead-lettered events and stuck bookings have
no counter anywhere.

**Coverage** — unit: none · integration: `apps/web/src/app/admin/admin-liquidity-stats.test.tsx` (2 —
reports the **median** not the mean, and averages applications over **every** published slot including
empty ones) · e2e: none → **partial**

> Two of nine queries covered — and they are the two that had already been wrong, which is correct
> prioritisation but leaves seven undefended. Any of them could silently report zero, and **a dashboard
> reading all-zeros looks like a quiet market, not a broken query.**

## O14. An admin finds a person, profile or booking — **important**

**Steps.** One box for email, phone, name or booking id: users by email/phone `ILIKE` or exact id (20
max); performers, venues and techs by name in one UNION (20 max); an exact booking when the query
starts with `bkg_`. Each user row shows status and the Suspend/Reinstate lever, **suppressed entirely
for deleted accounts**. Money actions are offerable only when payments are on, a `paymentRef` exists
and a durable parent charge row exists. The page states its own contract: every action here lands in
the events table under your name.

**What breaks.** Search is the front door to every account's email and phone, and the admin gate is the
only thing between that and a signed-in civilian — there is no read-only ops role. Silent truncation at
20+20 with no pagination and no "more results" signal. Bookings are findable only by exact id. Viewing
an account produces **no event**, so there is no record of who read whose contact details.

**Coverage** — unit: none · integration: `apps/web/src/app/admin/search/page.test.tsx` (4 — a fresh
`randomUUID` idempotency key on every successful form refresh; venue refunds offered only once
lifecycle settlement completes; money actions hidden when payments are off or no durable parent charge
exists; no suspend/reinstate control for deleted accounts) · e2e:
`e2e/account-lifecycle.spec.ts:83/:172/:205` drives the admin to ops search and uses the suspend lever
against a production build — **but navigates by URL, never typing a query** → **partial**

> **All four tests cover what the page OFFERS; none covers what it FINDS.** The search itself — the
> ILIKE queries, the three-way UNION, the `bkg_` branch, the 20-row caps — has no test at any layer,
> and it is the first step of every other ops journey in this document. A UNION leg that silently
> returned `[]` would pass all four tests plus the e2e.

## O15. **DORMANT** — an admin issues a manual refund or goodwill payment

`/admin/search` hides the form entirely unless `paymentsEnabled()`, and the adjust route rejects the
call with 409 `payments_disabled` regardless of the UI. **Today the lever cannot fire — any runbook
that assumes ops can refund a venue is wrong at launch.**

Despite being switched off this is the **deepest-covered admin surface in the repo**:
`apps/web/src/app/api/admin/admin-money.test.ts:205-490` has 15 adjustment tests (payments-off
rejection; no durable parent charge; a sound-subslot charge not mistaken for parent principal; venue
refund refused before settlement; `refund_venue` credits the venue; `pay_performer` treated as separate
platform-funded goodwill; base refunds counted against the original charge ceiling; **concurrent
refunds serialised so their sum cannot exceed the charge**; a retry with the same operation key not
duplicating the ledger row or event; two intentional identical adjustments with distinct keys allowed;
one key reused for different content rejected), plus `dispatch-effects.test.ts:123/:166` and
`ledger.test.ts:146/:172`. The 409 rejection is itself asserted, so **the dormant state IS the tested
state** → **dormant (well covered)**

> Do not spend gap budget here. If `PAYMENTS_ENABLED` is ever flipped, the first missing assertion is
> that the dollar figure rendered in the confirm dialog equals the cents the route actually moves.

## O16. **DORMANT** — the books are checked against themselves overnight

pg-boss cron at 04:30 UTC runs `reconcileMoney`. Invariant **A1**: for every booking in a money-settled
state, Σ charge must equal Σ (release + refund + fee), with **adjustments excluded on purpose so
goodwill cannot launder a shortfall**. Invariant **A2**: any release/refund/fee/adjustment with no
charge behind it is money from nowhere. Every mismatch is appended as a `reconciliation.mismatch` event
so it is durable, not just logged, and `MoneyMismatches` is published on **both** paths so a zero clears
the alarm once the books balance again.

**Partly dormant, not dead:** with payments off this checks an *intent* ledger, so a mismatch today is
bookkeeping drift, not a financial incident — worth knowing before anyone treats a red alarm as one.

**Coverage** — integration: `packages/db/src/reconcile.test.ts:199` seeds seven scenarios in one run —
balanced booking, short settlement, orphan refund with no charge behind it, a shortfall masked by an
adjustment, legitimate goodwill on an already-balanced booking, a fee+refund cancellation, and an
adjustment with no charge — and asserts exactly the right subset flags → **dormant (partial)**

> Untested: the Stripe cross-check branch (unreachable without a key), the `MoneyMismatches` publish on
> both paths, and the cron registration. The residual risk worth naming: **a run finding zero
> mismatches must still publish `MoneyMismatches=0`** — a suppressed zero leaves the alarm latched in
> ALARM forever after one bad night, which is how alarms get muted.

## O17. Nights that came and went stop being bookable — **important**

Hourly at :05 plus once at boot so a restart heals whatever accumulated while the worker was down.
`expirePastSlots` flips only `status='open'` slots whose start has passed to `expired` (idempotent by
construction) and **declines every still-pending application on those slots in the same transaction**,
using the ordinary decline event shape so each act gets a definitive answer instead of "Pending"
forever; the one *offered* application is left to its booking's `OFFER_EXPIRED` transition so nobody is
notified twice.

**What breaks.** This is the journey that **did not exist**: nothing ever wrote `slots.status='expired'`,
so past nights rendered an apply form forever and the fill rate counted every dead slot permanently. If
the hourly job stops, that state returns silently — no alarm watches it, and the count is only a log
line.

**Coverage** — unit: `apps/web/src/lib/slot-display.test.ts:10/:19/:25` (renders a stale open slot as
expired at and after downbeat, keeps future ones actionable, does not rewrite persisted non-open
statuses — the display half that holds the line before the sweep runs) · integration:
`packages/db/src/analytics.test.ts:121`; `apps/worker/src/notify-routing.test.ts:186/:209` (tells the
act its application closed because the date passed, and that the copy is truthful);
`apps/web/src/app/api/slots/[id]/applications/route.test.ts:47`;
`packages/db/src/transition.test.ts:389` · e2e: `e2e/aged-slot.spec.ts:5` drives it whole against a
production build → **covered**

> One of very few journeys covered at all three layers with assertions that would genuinely fail. The
> uncovered piece is **atomicity**: `analytics.ts:110` declines every pending application in the same
> transaction as the expiry — which is what turns "Pending forever" into a definitive answer — and no
> test forces a rollback to prove the two halves cannot diverge.

## O18. A venue is pulled back when its night draws nobody — **important**

Daily at 16:00 UTC, `staleOpenSlots` selects open, future, posted >48h ago, **zero applications**, live
venue, active owner, and no prior `slot.reengaged` event. The worker appends `slot.reengaged` **before**
notifying — the marker is the commit point, so a crash favours a missed nudge over a duplicate,
because spam is the worse failure (`apps/worker/src/index.ts:222`).

**What breaks.** Once per slot, forever: the marker never expires, so a night empty for six weeks is
nudged exactly once. Zero-applications is a hard filter, so a slot with one unusable application is
never nudged. An SES throttle mid-loop drops the remaining nudges for that day, and because the marker
is written first they are never retried.

**Coverage** — unit: none · integration: `packages/db/src/analytics.test.ts:416` pins the predicate
precisely — aged, unfilled, future, un-nudged surfaces and every near-miss does not, including the
dedup; `apps/worker/src/notify.test.ts:112` (`slot_quiet` resolves with no unresolved placeholder),
`:129` (**deep-links to `/performers` rather than the marketing homepage**) · e2e: none →
**partial**

> The selection is precisely covered; the delivery is not. The mark-then-notify **ordering** — the
> entire anti-spam design — is driven by no test and exists only as a code comment. And nothing asserts
> the nudge reaches the venue **owner**: `notify-routing.test.ts` never drives a `slot_quiet` row.

## O19. Scheduled maintenance runs, and a restart heals the gaps — **important**

Crons at 04:10 (night facts), 04:20 (series materialise), Mondays 05:00 (embed recheck) and hourly
(slot expiry) — **each also runs once at boot**, fire-and-forget with a log-only `.catch`, so a failed
self-heal never blocks startup and never pages. `snapshotNightFacts` is explicitly **unbackfillable**,
which is the whole reason the boot call exists.

**What breaks.** Night facts self-heal exactly **one** day back: a worker down for three days leaves a
permanent, unbackfillable two-day hole in the ROI baseline, and nothing reports it. No metric or alarm
covers any of these jobs. `recheckEmbeds` loads every asset with no pagination and HEADs each serially,
so one slow host stalls the sweep. The cron strings are the least-tested load-bearing config in the
repo: a typo turns a nightly job into a never-firing one with no error anywhere.

**Coverage** — unit: `packages/domain/src/recurrence.test.ts` (16) · integration: the **jobs** are
covered — `packages/db/src/analytics.test.ts:90/:110`; `packages/db/src/series.test.ts` (10);
`apps/worker/src/media.test.ts:91-110` · e2e: none → **partial**

> **The scheduling is covered by nothing. Verified: no test file in the repo imports
> `apps/worker/src/index`**, so the cron expressions, queue names and the boot self-heal calls at
> `index.ts:165/:178/:243` are never executed. **The one piece of this journey with no second chance —
> unbackfillable night facts — is the piece with no test.**

## O20. Sound tech leaves or is suspended — **important**

See **T15** in §3 — the tech-side wind-down. Verdict **partial**: the DB layer is thorough, but
`e2e/account-lifecycle.spec.ts` has venue and performer arms and **no tech arm**, and the wind-down
applies a reliability strike to someone who is leaving.

---

# 5. Cross-cutting — anonymous & any signed-in

Ten journeys every actor passes through. Two are dormant for the same structural reason, named below.

## X1. Sign in (or sign up) by email code — **core** *(anonymous)*

**Steps.** `/login` collects an email and a Terms checkbox and **nothing else** — it is the only
sign-in surface (`apps/web/src/app/login/page.tsx:39-69`). `POST /api/auth/request` validates
exactly-one-of phone/email, **refuses in production a destination whose channel isn't configured**
rather than silently dropping the code, and applies three layered rate limits (5/hour per destination,
20/hour per IP, 500/hour globally). A CSPRNG 6-digit code is minted — fixed `000000` only in
development/test, **default-random so an unset `NODE_ENV` fails safe**
(`apps/web/src/lib/otp.ts:15-19`). The otp row carries a 10-minute expiry and the outbox event carries
**only the otpId** — the code itself never enters the event log. On verify, a wrong code increments
attempts **in SQL** (`attempts + 1`, not read-modify-write) so parallel guesses each cost an attempt,
and a correct code is claimed atomically with the cap and not-consumed checks **pushed into the
WHERE**, so two concurrent correct submissions cannot both mint a session. Suspended accounts are
refused at the door, and a suspended user who deactivated leaves no row — so the hashed-identifier
blocklist is checked before creating a fresh account. Consent is recorded against the exact published
versions. `createSession` mints a 30-day HS256 cookie carrying `scope:'session'`.

**What breaks.** Worker down entirely: `/api/auth/request` still returns `{sent:true}`, nobody can sign
in, and the web tier reports healthy — the only thing that catches it is the outbox-lag alarm, which is
emitted **by the worker that is down**. `OTP_IP_HOURLY_CAP=20` is per requesting IP, so a venue behind
one NAT can lock out its own staff.

**Coverage** — unit: `apps/web/src/lib/otp.test.ts` (3 — fixed code only in dev/test, random elsewhere,
**fails safe on an unrecognised `NODE_ENV`**); `apps/web/src/lib/session.test.ts` (5 — accepts a real
session cookie; **refuses an iCal token as a session**, the account-takeover regression; refuses any
other purpose-scoped token on the same secret; still accepts pre-scope legacy sessions; rejects a
wrong-secret token); `apps/web/src/lib/client-ip.test.ts` (4 — prefers CloudFront's viewer address over
spoofable XFF) · integration: `apps/web/src/app/api/auth/verify/route.test.ts` (11 against real
Postgres — first-verify signup + session; consent recorded against the versions the pages publish;
**every** concurrent wrong guess counted; only one of two concurrent correct submissions claiming the
code; two-destination request refused; address identity case-insensitive both directions;
wrong/expired code; lockout at 5 attempts even with the right code; terms required; suspended account
refused at the door) + `request/route.test.ts` + `request/ratelimit.test.ts` +
`logout/route.test.ts` + `account/route.test.ts:104` (**a suspension survives self-deletion via the
hashed blocklist and blocks re-registration**) · e2e: every spec signs in through the real form and OTP
against a production build → **covered**

> The deepest-covered journey in the repo. Two holes worth naming: the global 500/hour limit is
> unasserted, and **the open-redirect guard on the `next` param at `login/page.tsx:84-88` has no test**
> — a cross-origin `next` is a live phishing vector on a sign-in page (gap **G9**).

## X2. **DORMANT** — sign in by SMS code *(anonymous)*

The route accepts `{phone}`, 503s in production without full Twilio config, and shares the otp row, the
outbox event and the worker path with **X1**. **There is no caller.** `/login` is email-only, and
`apps/web/src/app/api/auth/verify/route.ts:80` is the **only** site in the entire app that writes
`users.phone`; `/account` explicitly redirects address changes to support.

**This is not a coverage gap — it is a dead journey**, and listing it as "needs tests" would send
someone to write tests for unreachable code. The decision owed is product (add the entry point or
delete the branch), not test coverage.

**It is also the root of a much larger finding.** Because `users.phone` is never populated:
(a) `deliverUserNotification`'s SMS-preferred branch (`apps/worker/src/notify.ts:402`) is dead for every
web-signup user, so "SMS + email exist" in `prd-coverage.md` F5.2 is true only of email;
(b) the inbound SMS router's user lookup by phone can only ever match a phone-signup account, so **SMS
slot posting (F2.8) is unreachable for the same reason**; and (c) the day-of contact reveal on the
booking page renders `users.phone` and will always be blank. `testing.md` attributes the missing SMS
browser coverage to "A2P plus a Gemini key" — **that is not the binding constraint**: even with A2P
granted today, no user could acquire a phone number on their account.

**Coverage** — `apps/web/src/app/api/auth/request/route.test.ts:22` (the production 503). The
verify-side phone branch, the Twilio send path and the absent UI are untested → **dormant/uncovered**

## X3. **DORMANT** — stop receiving texts (STOP / START / HELP)

The webhook verifies the HMAC-SHA1 signature and **fails closed in production** when
`TWILIO_AUTH_TOKEN` is unset. Compliance keywords are handled **before any other routing**; replies are
TwiML with XML escaping; every later outbound notification re-reads the flag at the delivery boundary
and falls through to email.

Dormant for the **X2** reason: the lookup keys on `users.phone`, which nothing populates. **A STOP from
a real customer number matches zero rows and still returns the reassuring "You're unsubscribed" — a
compliance claim the database does not back.** There is also no email unsubscribe and no per-user
channel preference anywhere in the codebase.

**Coverage** — `apps/web/src/app/api/webhooks/twilio/route.test.ts` and `route.signature.test.ts` cover
STOP/START/HELP, unknown number, parse degradation and TwiML escaping. The "flag is honoured on the way
out" half (`notify.ts:402`) has **no test** → **dormant**

## X4. Leave EightGig — deactivate and wind down every live commitment — **important**

**Steps.** The button stays disabled until the literal word `DEACTIVATE` is typed.
`DELETE /api/account` resolves the session **without `requireUser`, deliberately, so a suspended
account can still leave**. `deactivateAccount` opens one transaction and takes `FOR UPDATE` on the user
row — the shared creator gate. Every offered/confirming/confirmed booking is driven **through the real
state machine, not UPDATEd**, so slots reopen, timers cancel and counterparties get the ordinary
notice; that wind-down **retries up to 4 times** against a booking that advances underneath the
worklist read rather than swallowing `IllegalTransitionError`. Active series are locked **in id order
before any booking transition can lock a slot** (deadlock ordering), then cancelled; remaining open
slots — including ones the cancellations just reopened — are closed. If the account was already
suspended, both identifiers are SHA-256 hashed into `blocked_identifiers` so the suspension outlives
the deletion. The user row becomes `deleted` with email and phone nulled, and
`setProfileVisibility(userId,'hidden')` runs **in the same transaction** so a venue's street address is
never public a moment longer.

**What breaks.** Half-deactivation is impossible by design: if any transition, ledger write or outbox
append throws, the whole transaction rolls back and the account stays active — but to the user the
button just errors, with no explanation of which commitment blocked it. The counterparty finds out
only by email; there is no in-app "the other side left" state beyond the cancelled booking and the
disabled Reply on the thread.

**Coverage** — unit: `apps/web/src/lib/profile-capabilities.test.ts` · integration: **the strongest in
the repo** — `packages/db/src/account.test.ts` (14 incl. 3 race seams via hooks: the gate race at
`:224`, the late payment success at `:506`, the deadlock ordering at `:632`, and *"does not delete the
account when a booked-work transition really fails"* at `:457`); `account-suspension.test.ts` (6);
`visibility.test.ts` (4); `apps/web/src/app/api/account/route.test.ts` (4) · e2e: **both**
`e2e/account-lifecycle.spec.ts` tests, which assert discovery removal, the 404 on the public venue URL,
and the signed-out `/account` → **covered**

## X5. Something happens → the right person is told — **core**

**Steps.** The producing transaction appends the event and its effects **atomically with the state
change** — `packages/db/src/events.ts:17-28` states the contract: same transaction, or the notice can
exist without the fact. `drainOutboxOnce` dispatches and marks each row independently (**O2**).
`dispatchEvent` routes `notify` by `subject_type` — booking / tech_subslot / auth / slot / thread —
with an explicit `notify.unrouted` log for anything else. Subject-specific resolvers turn an id into
recipients; `notifyApplicationPerformer` routes an application **outcome** to the act, not the venue.
`renderTemplate` resolves 40 versioned templates plus the `PAYMENTS_ENABLED`-off **discovery
overrides**. `deliverUserNotification` picks SMS if phone + Twilio + not opted out, else email, else a
structured log sink. `notifyUser` **re-reads the recipient's account status at the delivery boundary**
and drops anything for a non-active user; the one sanctioned exception is hard-coded to one template
and one status. `sendEmail` propagates every SES failure so the outbox retries instead of silently
marking dispatched; `sendSms` treats 4xx as permanent and 5xx/429 as retryable.

**What breaks.** The historical bug is the shape to remember: `sendEmail` used to **swallow** SES
errors, so the dispatcher marked the row dispatched and nobody was ever told their gig was confirmed,
with both alarms green. Fixed, and now load-bearing. Dead-lettered notifications are parked and the
user is simply never told. And with **X2** dormant, everything routes to email in practice, so an act
who never opens email is unreachable — there is no in-app notification centre.

**Coverage** — unit: none · integration: `apps/worker/src/outbox.test.ts` (3);
`notify-routing.test.ts` (11 incl. the account-status recheck at `:257` and the suspension exception at
`:275`); `notify.test.ts` (per-template placeholder regressions and a *"never point a subject email at
the marketing homepage"* assertion); `support-notification.test.ts` (5); `review-prompt.test.ts` (3);
`reconcile-loop.test.ts` (6) · e2e: the Confirmed badge in `booking-journey` is produced by real
delivery → **partial**

> **Gap G4.** Four wires are exercised by nothing: `slot.created → matchSavedSearches → slot_match`
> (`index.ts:564-570`); the `performer.created → new_act` venue fan-out (`:586-591`, although the
> `act_welcome` half beside it **is** covered); the daily `slot_quiet` job (`:217-231`); and the
> day-before reminder job (`:123-135`). `testing.md` gap #4 calls dispatch routing "exercised
> indirectly"; these four are exercised **not at all**.

## X6. Talk to the other side of a booking — **important**

**Steps.** `ensureBookingThreadInTx` creates the thread and both participants **inside the same
transaction as the offer**, so an offer never exists without its conversation; the partial unique index
on `(scope='booking', subjectId)` is the concurrency boundary. The worker idempotently re-runs it off
`booking.offered` to heal anything imported outside the write path. Messages are windowed newest-first
then reversed, so a long thread shows the **latest** 200 not the oldest — a regression that shipped
once and is now fixed on both the page and the API. Posting re-checks participation, locks every
participant's account row, then locks the thread and the participant row before inserting. Reply is
withdrawn in the UI the moment any participant account stops being active.

**Coverage** — unit: `apps/web/src/lib/thread-display.test.ts`;
`apps/web/src/lib/thread-profile-labels.test.ts` · integration:
`apps/web/src/app/api/threads/threads.test.ts:113` (message rolled back when its outbox event cannot
be appended), `:148` (messaging a ghost 409s); `packages/db/src/booking-thread.test.ts`;
`apps/worker/src/notify-routing.test.ts:332` (backfill produces exactly one thread with exactly both
participants), `:356-395` (`new_message` reaches only the non-sender);
`apps/web/src/app/inbox/page.test.tsx` and `inbox/[id]/page.test.tsx:90` · e2e:
`e2e/booking-journey.spec.ts:168-190` drives a real two-way conversation between the act and the venue
against a production build → **covered**

> No mute, no block, no read state, no unread badge anywhere — a user being pestered inside a booking
> thread has only `/help`. The long-thread windowing fix has no test on either surface.

<a id="x7-inquiry-thread"></a>
## X7 (=V17). Open a cold conversation with a profile — **important** *(actor: venue; counted under Venue)*

**Steps.** Direction is decided by identity, not by a parameter: only a venue may open to a performer;
a venue **or** a performer may open to a tech; performer→venue cold messaging is refused. A multi-role
account prefers its live venue identity for tech outreach. `lockActiveProfileOwners` locks owners then
re-reads profiles, so a hidden or deactivated recipient is rejected **without creating a thread**.
Self-messaging returns a clean 409. The daily anti-spam cap of 10 counts threads the caller
**created**, not ones opened with them — a real bug, since it used to lock a popular act out of
*sending*.

**Coverage** — unit: none for `inquiryCreateSchema`'s exactly-one-of refinement · integration:
`apps/web/src/app/api/threads/threads.test.ts` (10 — direction rules, hidden/deactivated recipients,
the self-inquiry 409, the cap counting the right direction at `:172`, thread-list isolation, the
no-profile 403 at `:316`) · e2e: none → **covered**

> The 429 branch itself has no test: raise `DAILY_INQUIRY_CAP` to 1000 or delete the check and the
> suite stays green. And "no profile" and "wrong direction" return the **same** error text, so a user
> cannot tell them apart.

## X8. Be pulled back to the marketplace when it has something for you — **important**

`performer.created` fans **out** to every venue owner holding an open, future slot the act fits —
kind→format mapping, metro equality, budget floor vs the act's `rate_min`, live venue, active owner
(`packages/db/src/analytics.ts:151-176`) — and then the act's own owner gets `act_welcome`, **sent
last** so an SES throttle mid-fan-out re-delivers venue alerts rather than a second welcome. A daily
job nudges quiet slots (**O18**); an hourly job expires past nights with a definitive
`application_expired` (**O17**).

**What breaks.** `new_act` has **no dedup marker and no per-venue frequency cap** — a burst of signups
in one metro emails the same venue repeatedly. An act whose `rate_min_cents` exceeds every open slot's
budget silently matches nothing.

**Coverage** — integration: the matchers are tested (`analytics.test.ts:307` for
`matchOpenSlotsForPerformer`, `:416` for `staleOpenSlots`, `:121` for slot expiry) · e2e: none →
**partial**

> **The three worker jobs that CALL them have no test.** `act_welcome` is the only dispatch-side
> notification here that is covered (`notify-routing.test.ts:451,472`).

## X9. Trust becomes visible — double-blind reviews and the reliability badge — **core**

**What it is.** With payments off, **this is the trust layer**: a booker can see whether an act shows up
and what rooms said about them, and neither side can read the other's review before committing to their
own.

**Steps.** Entering a reviewable state arms a deduped prompt 24h later, gated on
`isReviewableBookingState` — **only `released` and `partially_released`**; cancellations, collapses,
refunds and unresolved disputes are not reviewable. `pendingReviewAudience` asks only the side that
still owes one and drops the prompt once both have written. The route checks **state before role**, so
an outsider learns only that reviews aren't open. Visibility is a pure read-side rule: visible once the
counterpart side reviewed the **same booking**, or strictly more than 7 days have passed
(`packages/domain/src/reviews.ts:8,32-46`). The DB read path **independently re-filters** to the
completed-state allowlist so legacy reviews on cancelled bookings cannot leak onto a profile. The star
average returns **null rather than a misleading 0.0** when nothing is visible. Reliability is derived
independently of reviews from two facts — released bookings and the cancellation strike counter — with
a cancellation weighted 5× a gig, and surfaces exactly where a decision is made: the applicant list,
the act directory, the public act page.

**Coverage** — unit: `packages/domain/src/reviews.test.ts:13-45` (exhaustive incl. the **exactly-7-days
boundary** and the "counterpart on a DIFFERENT booking does not unlock" case);
`packages/domain/src/reliability.test.ts` (6);
`apps/web/src/lib/review-display.test.ts` (3) · integration:
`apps/web/src/app/api/bookings/[id]/review/route.test.ts` (6 — 201 then 409 on a second review by the
same side; **rolls the review back when its outbox event cannot be appended**; accepts every
completed-gig outcome; rejects active/collapsed/cancelled/refunded/unresolved **without side effects**;
403 non-party; 422 missing `overall`, 401 anon); `packages/db/src/reviews.test.ts:116`;
`apps/worker/src/review-prompt.test.ts` (3) · e2e: `e2e/post-gig.spec.ts:184-196` submits **both**
reviews, then checks the public page → **partial**

> **Gap G5.** The page-level wiring that applies the rule — the `visibleReviews(allReviews, role)` calls
> at `p/[id]:95`, `v/[id]:81`, `t/[id]:63` — has **no test**: `p/[id]/page.test.tsx` covers bio and
> media only, `v/` and `t/` cover photos only. And because the e2e submits both reviews before looking,
> **it never observes the hidden state**. A regression passing the wrong role, or dropping the call
> entirely, ships green — and an early-visible one-sided review destroys the mechanism, because
> retaliatory reviews are exactly what double-blind exists to prevent.

## X10 (=T3). A venue or act discovers a sound tech — **important**

See **T3** in §3 — verdict **partial**, and the section's clearest example of a test
file named for a surface it does not assert.

## X11. Put your EightGig gigs in your own calendar — **peripheral**

**Steps.** `POST /api/calendar` mints a 365-day HS256 token carrying `scope:'ical'`, signed with
`SESSION_SECRET`; `GET` verifies it and **requires `scope==='ical'`**. Because the token outlives every
account change by up to a year, **the account is re-checked on every fetch** — a calendar app polls
this for months. Confirmed and awaiting-confirmation bookings render as VEVENTs with the venue's full
street address and the pay. The reciprocal defence lives in the session layer: `sessionUserId` refuses
**any** token minted for another purpose, so this shareable URL can never be replayed as a login.

**What breaks.** The historical account-takeover — same secret, same `sub`, a URL users are told to
share with bandmates that was also a login — is closed by the purpose claim and directly tested. There
is **no revocation** short of rotating `SESSION_SECRET`, which invalidates every session on the
platform. And the sound tech, the one side of the market whose job *is* a calendar of load-ins, is not
in the feed at all (**T10**).

**Coverage** — unit: `apps/web/src/lib/session.test.ts:33` (**refuses an iCal feed token as a
session**) · integration: `apps/web/src/app/api/calendar/route.test.ts` (2 — mint + serve; reject
missing/forged tokens) · e2e: none → **partial**

> **Gap G10.** The "account went inactive, feed must stop" path — the entire reason
> `assertAccountActive` was split out of `requireUser` (`apps/web/src/lib/auth.ts:85-92` documents
> exactly this) — has no test. It is the one authenticated surface that outlives the session cookie by
> up to a year.

---

# Gaps, ordered by criticality × exposure

Ordering is **how bad is it if this breaks × how many people touch it**, not by how hard the test is to
write. Each entry names the journey, the layer, and **what the test should assert** — not "add
coverage".

Two exclusions, stated so nobody re-derives them: **dormant money paths are out of scope** (G-list
entries would be tests for a rail that cannot fire — see O15/O16/T16/X2/X3), and **schema gaps are not
coverage gaps** (techs having no metro column, `reliabilityStrikes` having no threshold logic, ratings
being `{overall}` only — no test could catch those; they are product decisions).

## G1. The media moderation gate is asserted at no layer, for no subject type — **do this first**

**Journeys:** A2, A14, T2, O8, V12 · **Layer:** page integration · **Exposure:** every public profile

`apps/web/src/app/p/[id]/page.test.tsx:110`, `v/[id]/page.test.tsx:34` and `t/[id]/page.test.tsx:27-36`
each hardcode `status: "ready"` in their media fixtures. Therefore:

> Deleting `eq(schema.mediaAssets.status, "ready")` from `p/[id]/page.tsx:87` — or the equivalent line
> on `v/[id]` or `t/[id]` — **publishes every held and blocked link and breaks no test.**

This is the single most consequential hole found, because it is the entire point of the media rail. A
link lands `held` specifically so an unscreened URL is not on a public page (`technical-design.md` A10:
*"Nothing publishes media before screening"*). The AI screen is the only path to `ready`; ops
`block` is the only path out. Both of those writes **are** tested — `apps/worker/src/media.test.ts`
proves a high-risk asset stays `held`, and `flag-resolve-media.test.ts` proves uphold writes
`blocked` — and **neither of those states has any observable meaning in the suite**, because nothing
renders a page with a non-`ready` asset.

**Assert:** on each of the three page tests, stop defaulting the fixture's status; seed **one `ready`
and one `held`** asset on the same subject; render; assert the held asset's `embedUrl` **and** its
`embedMeta.title` appear **nowhere** in the HTML. Then add a `blocked` case to at least one of them, so
upholding a flag has a consequence a test can see. Three assertions total; they close A2, T2, O8 and
half of A14 and V12 at once.

## G2. `POST /api/performers` — the demand side's front door — has no test at all

**Journey:** A1 · **Layer:** route integration · **Exposure:** every act that ever joins

There is no `apps/web/src/app/api/performers/route.test.ts` and **no test file imports the route**. The
sound-tech equivalent (`apps/web/src/app/api/techs/route.test.ts`) tests exactly the two things missing
here, so the pattern to copy already exists.

**Assert:** (a) two concurrent POSTs yield exactly `[201, 409]`, exactly one `performers` row, exactly
one `performer.created` event, and the 409 body matches the exact copy — this drives the real
`performerOwnedBy` preflight **and** the partial unique index race through `respondProfileCreateError`;
(b) a real `before insert on events` trigger forces the event append to fail, and the test asserts
**zero** performer rows and zero events. And, unlike the tech test, (c) select the **full row** and
assert `kind`, `homeMetro`, both rates **in cents**, `genreTags` and `techNeeds` match what was posted —
the tech test asserts row counts, never values, and that hole is worth not copying.

**Why it ranks here:** deleting the `appendEvent` call at `route.ts:38-44` today silences both
`act_welcome` (the only day-one message an act ever gets) **and** the `new_act` venue fan-out, with a
green suite. Do the same for `POST /api/venues` while in the file — it is executed only as a fixture
helper inside `slots/create.test.ts`.

## G3. `/slots` — the act's primary discovery surface — has no page test

**Journey:** A3 · **Layer:** page integration · **Exposure:** every act, every session

`/slots/[id]`, `/performers`, `/techs`, `/bookings`, `/me`, `/inbox`, `/p/[id]`, `/venues` and `/v/[id]`
all have page tests. `/slots` does not. The whole listing body could render blank and only the
DB-level filter test would still pass.

**Assert:** with real rows, (a) one open future slot renders its pay, its **venue-local start time with
zone**, duration, address, the `/v/{id}` link and the recurring badge; (b) each of the four empty
states renders for its own viewer — filtered-to-nothing, cold-market-with-a-live-act,
owned-but-inactive act, and signed-out — the last asserting it offers what an **act** can do, since the
comment at `page.tsx:135-138` records that this branch previously addressed venues on the acts' page;
(c) the 50-row cap with soonest-first ordering holds, so a crowded board cannot silently hide the
nights closest to happening.

## G4. Producer-side notify effects are asserted only from hand-built fixtures

**Journeys:** A4, A6, X5, X8, A13, T9 · **Layer:** worker integration · **Exposure:** every notification

`apps/worker/src/notify-routing.test.ts` proves **routing** — given an outbox row of this shape, the
right people are told. It hand-builds the row. So the producer→consumer contract is joined by nothing,
and five specific wires are exercised by **no test at any layer**:

| Wire | Site | If it broke |
|---|---|---|
| `slot.created` → `matchSavedSearches` → `slot_match` | `apps/worker/src/index.ts:564-570` | acts stop hearing about matching gigs; nothing tells anyone |
| `performer.created` → `new_act` venue fan-out | `:586-591` | venues stop hearing about new acts |
| `application.submitted` → `new_application` | producer at `slots/[id]/applications/route.ts:85-89` | **the venue never learns anyone applied** |
| `booking.offered` → `offer_received` | `packages/domain/src/booking/machine.ts:271` | **the act is never told they have an offer** |
| `subslot.transition` → `subslot_booked` (`to:"both"`) | `packages/db/src/subslots.ts:561-580` | the booked tech is never told they got the job |

**Assert:** in `notify-routing.test.ts`'s existing `drainAndCaptureSinks` harness, call the **real**
producer (the apply route, `createOffer`, `bookTechApplicant`) and then drain, asserting the sink's
`{userId, template}` pairs. For `subslot_booked` specifically assert **two** recipients, which also
exercises the untested `to:"both"` branch and its tech-owner lookup, and assert the body deep-links
`/sound/{subslotId}` rather than `/bookings`.

## G5. The double-blind review rule is never applied through a page in any test

**Journey:** X9 (also A14, T14, V12) · **Layer:** page integration · **Exposure:** the whole trust layer

The pure rule is exhaustively tested including the exactly-7-days boundary. The three calls that
**apply** it — `p/[id]/page.tsx:95`, `v/[id]/page.tsx:81`, `t/[id]/page.tsx:63` — have no test, and
`e2e/post-gig.spec.ts` submits **both** reviews before it looks at the public page, so it never observes
the hidden state.

**Assert:** on `/p/{id}`, seed one venue-authored review 1 day old with no counterpart → assert its body
does **not** appear and no ★ badge renders (`averageOverall` returns null, so it must be absent, not
"★ 0.0 (0)"). Add the act's counterpart review on the same booking → assert the body now appears and
the header reads "★ 5.0 (1)". Then, on `/t/{id}`, assert the **tech-authored** review body never
appears in either state — flipping `"payer"` to `"tech"` at `t/[id]/page.tsx:73` currently publishes a
tech's reviews *of payers* on their own profile with a green suite.

**Why it ranks here:** with payments off this is the trust layer, and an early-visible one-sided review
is exactly the retaliatory-review failure double-blind exists to prevent.

## G6. The worker publishes metrics nobody proves the alarms are watching

**Journey:** O3 (the document's only **uncovered** journey) · **Layer:** worker + infra

`apps/worker/src/index.ts:794` publishes `OutboxLagMs` and `DeadLetteredEvents`;
`infra/cdk/lib/gigit-stack.ts:648/:678` alarms on those names. **The two are joined only by duplicated
string literals** — no shared constant, no test spanning them. Rename one side and the alarm silently
watches a metric nobody publishes, with both suites green. Worse, `index.ts:798` swallows every error in
the health block, so a health check that throws on every pass is invisible.

**Assert:** import **one exported constant** into both the worker and the CDK test. Failing that, assert
`putMetrics` is called with exactly `"OutboxLagMs"` and `"DeadLetteredEvents"` when `GIGIT_STAGE` is
set, and **not called** when it is unset (the guard that keeps local runs off CloudWatch). This is the
only journey in the document where nothing fails at all, and it is the journey whose job is to tell a
human that everything else has stopped.

## G7. Public profile pages: nothing asserts the page **body** 404s a non-live profile

**Journeys:** A14, T3, V12 · **Layer:** page integration

`packages/db/src/visibility.test.ts` proves the status column flips. `profile-metadata.test.ts:53`
proves the **unfurl** gate fails closed. Nothing proves the **page** reads the column — and the
`t/[id]` case is a documented, shipped regression (*"setProfileVisibility wrote techs.status and
nothing ever read it"*). Removing the status gate from `t/[id]/page.tsx:38`,
`api/techs/[id]/route.ts:26` and the directory query breaks **zero** tests.

**Assert:** for each of `/p/{id}`, `/v/{id}`, `/t/{id}`: a `hidden` profile and a `suspended` profile
each throw `notFound`, and a `live` one renders. Add the equivalent to `GET /api/techs/[id]` — its
payload includes rates and profile detail.

## G8. `apps/worker/src/index.ts`'s `main()` is imported by no test

**Journeys:** O2, O4, O5, O17, O18, O19 · **Layer:** worker

Tests import `drainOutboxOnce` and `reconcileOnce` and nothing else. So the cron expressions, the queue
names, and the three fire-and-forget boot self-heal calls (`:165`, `:178`, `:243`) are **never
executed**. A typo in a cron string turns a nightly job into a never-firing one with no error anywhere,
and each boot call has a log-only `.catch`, so a self-heal that throws on every restart is completely
invisible.

**Assert:** the highest-value single case is `snapshotNightFacts` — that data is explicitly
**unbackfillable**, which is the whole reason the boot call exists, and it is the one piece of the
system with no second chance. Assert that boot runs it for yesterday **exactly once**, and that a throw
inside it does not prevent the worker reaching its main drain loop. Second: assert the registered cron
expressions match the documented schedule (04:10 / 04:20 / Mon 05:00 / hourly) by asserting on the
scheduling call rather than the clock.

## G9. The open-redirect guard on `/login?next=` has no test

**Journey:** X1 · **Layer:** unit/page · **Exposure:** the highest-value page in the app

`apps/web/src/app/login/page.tsx:84-88` restricts `next` to same-origin. A cross-origin `next` is a
live phishing vector on a sign-in page, and the guard is asserted nowhere — while every other branch of
this journey (11 route tests against real Postgres, including the concurrency and lockout paths) is.

**Assert:** verifying with `next='https://evil.example/x'` lands on `/onboarding` and never on the
attacker's host; a same-origin `next=/slots/abc` is honoured; a protocol-relative `//evil.example` is
refused.

## G10. The iCal feed is not proven to stop when the account does

**Journey:** X11 (also O9) · **Layer:** route integration

`assertAccountActive` was **split out of `requireUser` specifically so the signed-token calendar feed
re-checks status on every fetch** — `apps/web/src/lib/auth.ts:85-92` documents exactly this — and no
test suspends an account then re-fetches its feed. The token outlives every account change by up to a
year and there is no revocation short of rotating `SESSION_SECRET`.

**Assert:** mint an iCal token, suspend the account, and assert the next `GET /api/calendar?token=…` is
refused. Then deactivate a different account and assert the same. The payload is the venue's full
street address and the pay, so a stale feed is a data leak, not just a stale calendar.

---

## The next ten, briefly

| # | Journey | Layer | Assert |
|---|---|---|---|
| G11 | T6 (post sound job) | route | Add the POST to `apps/web/src/app/api/authz.test.ts` — it is the one mutating booking route absent from the matrix. 401; 403 stranger and the other venue's owner; 409 on a parent that is `offered`/`cancelled`/`released`; 400 on `budgetCents: 0`. **And decide the payer-consent question** (T6's finding): an act can commit the venue to a bill today. |
| G12 | T5 / V5 (sound verdict) | page | `soundVerdictClass` is imported by no test. Assert an `unknown` booking renders `badge warn` — not `badge` — and a `covered` one renders `badge good` with no gap list and no "Post the sound job" form. The existing booking-page assertions are all negative and pass when the feature is deleted. |
| G13 | O14 (ops search) | page | Assert what the page **finds**, not what it offers: a query matching both a venue name and a performer name returns both rows labelled by type, and a `bkg_…` query returns the booking card with state and amount. A UNION leg silently returning `[]` passes all four current tests plus the e2e. |
| G14 | T7 (tech applies) | route | `GET /api/tech-subslots` is public, unauthenticated, unfiltered by parent state/downbeat/profile status/owner status, and returns the venue's **full street address**. No test file. Assert the exclusions — or delete the route; the finding stands either way. Same shape: `/api/techs/list` and `/api/performers/search`, both with no test and **no in-app consumer**. |
| G15 | O7 (support queue) | route | Fire **two concurrent claims** on one open request; assert exactly one 200 and one 409, exactly one `claim` note row and one `support.claimed` event. The conditional UPDATE exists only for this race and is proven today by a second sequential call. |
| G16 | O11 (dispute) | integration | Resolve a dispute with `fault:'performer'` and assert that performer's `reliability_strikes` went 0 → 1 and that `/p/{id}` renders the mixed-reliability badge. The reducer's *emission* is unit-tested; the **write** at `transition.ts:459-468` is not. |
| G17 | A4 (apply) / A5 (withdraw) | route | The act's optional note is untested at every layer — assert it persists, renders to the venue at `slots/[id]/page.tsx:305-309`, and that the 1000-char bound holds. Add the duplicate-apply 409, the unknown-slot 404 and the no-profile 403 (all asserted for techs, none for acts), and the withdraw-after-offer 409 — the race the row lock exists for. |
| G18 | O4 (timers) | worker | Assert the day-before reminder for a booking no longer `confirmed` sends **nothing** and logs `reminder.stale`; and that arming the same timer twice for one booking yields exactly one pg-boss job. A reminder texted for a booking cancelled hours earlier passes everything today. |
| G19 | V8 (act search) / V5 (applicants) | page | Assert the `/performers` kind/genre/metro filters and the `reliabilityStrikes`-then-`createdAt` ordering; and on `/slots/[id]`, assert an applicant card renders the reliability badge, the per-applicant sound verdict and the act's note — `slots/[id]/page.test.tsx` has zero occurrences of "sound", "plan" or "verdict". |
| G20 | T11 (tech cancels) | integration | Extend the reopen test: seed a second tech's submitted application plus the cancelling tech's booked row, and after `TECH_CANCELLED` assert **zero** rows remain in `techSubslotApplications` and that a previously-applied tech can apply again. This is a shipped regression whose fix can be deleted with the whole suite green. |

## Two structural gaps that are not test gaps

Named here so they are not mistaken for missing coverage and handed to someone to test:

1. **Media has no list and no delete.** `MediaManager` is add-only, no DELETE route exists, and the
   quota error literally says *"Remove one to add another"* — an action the product does not implement.
   An act who pastes a wrong link, or fills the 5-video quota, is stuck with it permanently. Nothing
   tests this because there is nothing to test.
2. **A held link is invisible to its owner.** `media.ts` notifies only on `embed_dead`;
   `apps/worker/src/notify.test.ts:66-69` affirmatively asserts that `media_rejected` was **deleted**
   and nothing replaced it — so **silence is the tested-in behaviour**. The act sees an empty EPK, no
   status and no explanation, while the owner prompt keeps asking for media they already added.

---

# Tests that look like coverage and cannot fail

Collected so they are not counted twice. Each of these is green today and would stay green if the thing
it appears to defend were deleted. This is the list to fix before adding anything new, because it is
the list that makes the suite's size misleading.

| Test | What it appears to prove | What it actually proves |
|---|---|---|
| `apps/web/src/app/p/[id]/page.test.tsx:110`, `v/[id]:34`, `t/[id]:27-36` | only screened media is public | nothing — every fixture hardcodes `status:"ready"`, so the filter can be deleted (**G1**) |
| `apps/web/src/app/techs/page.test.tsx` (3) | the sound-tech directory renders | the **sound-job panel** renders. Deleting the entire `techs.map(...)` block fails no test |
| `apps/web/src/app/api/techs/route.test.ts` (2) | a tech profile is created correctly | that **one row and one event exist**. It selects only ids — swap the two rate columns or drop `gear` and both tests pass |
| `apps/worker/src/notify-routing.test.ts` (11) | the right person is notified | that a **hand-built** outbox row routes correctly. No producer is driven, so the emitting side is unjoined (**G4**) |
| `apps/web/src/app/bookings/[id]/page.test.tsx:153,239` | the sound card behaves | two `not.toContain("Post the sound job")` assertions — **negative assertions pass when the feature is deleted**. There is no positive counterpart at any layer but e2e |
| `packages/db/src/visibility.test.ts` | non-live profiles leave discovery | that the **column flips**. No test reads it back through any page or route (**G7**) |
| `infra/cdk/test/infrastructure-guarantees.test.ts:61-63` | outbox alarms work | that the **CDK** watches the names it was given. The worker publishes them from a duplicated literal (**G6**) |
| `apps/web/src/lib/sound-display.test.ts:16-31` (cited as verdict-badge coverage) | the verdict badge is styled correctly | `equipmentCount` and `houseOperatorLabel`. `soundVerdictClass` is imported by **no test in the repo** |
| `apps/web/src/lib/sound-display.test.ts:167-190`, `sound/[id]/page.test.tsx:199-237` | the `withdrawn` sound-application state renders | a state **the system cannot produce** — withdrawal DELETEs the row; the test manually `UPDATE`s one to `withdrawn` |
| `apps/web/src/app/onboarding/page.test.tsx:120-129` | a new tech lands on a board they can act on | the **returning**-tech branch. It renders `welcome=1`, which the tech creation path never produces (it redirects straight to `/techs`) |
| `packages/domain/src/reviews.test.ts` (5) | double-blind visibility holds everywhere | the rule for `venue`/`performer` roles on object literals. The `"payer"` role and the `subslotId`→`bookingId` mapping `/t/[id]` actually uses are unasserted (**G5**) |
| `e2e/post-gig.spec.ts:184-196` | reviews are hidden until both sides write | nothing about hiding — it submits **both** reviews first, then checks the page |
| `e2e/sound-tech.spec.ts:23` (`/Needs a tech/i`) | the sound verdict renders | that *a* non-covered verdict renders. The regex is a prefix of "Needs a tech and a rig", so it cannot distinguish the two |
| ~15 files inserting `needs: { verdict: "tech_needed", … }` by hand | the sound plan is covered across the app | fixture shape. Every one matches a grep for "verdict"; none calls `soundPlan`. Only `subslots.test.ts:197` asserts a verdict the code produced |
| `apps/web/src/app/api/admin/admin-money.test.ts` (15) | manual money movement is safe | it is — **against a rail that cannot fire** (`PAYMENTS_ENABLED=false`). Deep, real, and dormant |

---

# Dormant journeys — do not write tests for these

Five journeys cannot execute in the launch configuration. All five have real code, most have real
tests, and none of them can be reached by a user today. They are listed so a gap-hunting reader does
not spend a week on a switched-off rail.

| Journey | Why dormant | State of coverage |
|---|---|---|
| **O15** — admin moves money manually | `PAYMENTS_ENABLED=false` **and** no Stripe key; the UI hides the form and the route 409s `payments_disabled` regardless | 15 route tests + gateway seam. **The dormant state IS the tested state** — the 409 is asserted |
| **O16** — nightly money reconciliation | runs, but checks an **intent** ledger; the faults it hunts can only be produced by the money rail | 7 seeded scenarios in one run, precise. Stripe cross-check branch unreachable |
| **T16** — tech is paid through the platform | same switch; **plus** techs have no `stripeAccountId` column and no sub-slot money effect is ever handed to the gateway | ledger conservation and idempotency tested; the payout leg has no row-level assertion |
| **X2** — sign in by SMS code | **no caller.** `/login` is email-only and `verify/route.ts:80` is the only site in the app that writes `users.phone` | request-side 503 tested; verify-side phone branch untested |
| **X3** — SMS STOP/START/HELP | keys on `users.phone`, which nothing populates — so a STOP matches zero rows and still answers "You're unsubscribed" | keyword routing, signature and TwiML escaping tested; the honoured-on-the-way-out half is not |

**X2 is the one to act on, and the action is a product decision, not a test.** Because `users.phone` is
never populated, the entire SMS half of the product is stranded downstream of it: SMS-preferred
notification delivery is dead for every web-signup user, inbound SMS slot posting (F2.8) can never
match an account, and the day-of contact reveal renders a blank phone forever. `testing.md` attributes
the missing SMS coverage to "A2P plus a Gemini key"; that is not the binding constraint. Either add a
phone entry point or delete the branch — but do not commission tests for it.

---

# Maintaining this document

- A journey belongs here when a **person** can describe it in one sentence without naming a route.
- Every step cites `file:line`. If a citation cannot be found, the step is a guess and should be cut.
- A coverage line may only claim a layer after opening the test and confirming the assertion can fail.
  When it cannot, say so inline and add it to
  [Tests that cannot fail](#tests-that-look-like-coverage-and-cannot-fail) — that table is more useful
  than the verdict counts.
- When a gap is closed, move it out of the G-list and into the journey's coverage line. When a *new*
  regression is found in production, `testing.md`'s convention applies: **the regression test goes at
  the lowest layer that can express it**, and the journey's coverage line here gets updated to say so.
