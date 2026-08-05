# Functional and UX audit remediation backlog

Generated: 2026-07-20

This backlog converts the end-to-end functional, product, UX, accessibility, copy, maintainability, testing, analytics, and operational audit into implementation tasks. Per product direction, security review and dormant payment-rail work are explicitly out of scope.

## Status legend

- TODO — not started
- IN PROGRESS — implementation or verification underway
- DONE — acceptance criteria and required tests pass
- BLOCKED — external input or prerequisite is required

## Definition of done for every task

A task is complete only when its implementation, migrations or backfills where relevant, focused unit/integration/route coverage, permanent Playwright coverage for user-visible behavior, accessibility checks for UI changes, relevant typecheck/build/full suites, and documentation/backlog updates all pass. External operational tasks require recorded verification evidence rather than invented unit tests.

## Remediation pass — 2026-07-30

This pass reconciles the backlog with the functional and UX work now present in
the repository. Security review remains explicitly out of scope. Statuses are
deliberately conservative: implemented code stays **IN PROGRESS** when any
acceptance item or required browser/accessibility evidence is still missing.

Completed against this backlog's definition of done in this pass:

- Recurring series now honor the venue-local first-night anchor through DST,
  persist it, materialize it idempotently, and assert the exact first listing in
  the production Playwright journey (COR-02).
- Sound-tech selection now prevents overlapping assignments across bookings,
  remains race-safe, and preserves the rejected job and application for another
  choice in the production Playwright journey (COR-07).
- Playwright now supervises production web and worker artifacts with readiness,
  startup-failure, signal, and teardown coverage and is the CI E2E entry point
  (QA-01).
- Venue search now sends a slot-bound firm invitation, with transactional route
  coverage and a permanent search-invite-decline browser response (DISC-08).

Implemented and verified foundations that remain broader in-progress tasks:
aged-slot guards, refill restoration, atomic series cancellation, account
lifecycle handling, isolated E2E databases,
profile-field clearing, form IDs and mutation feedback, centralized labels and
presentation helpers, booking conversations, inbox context, notification
routing, contact reveal, and post-gig dispute/review coverage.

Intentional future product and operational work remains open rather than being
reported as a regression in this pass: favorites/shortlists and comparison,
maps and sharing, notification preferences/notification center and richer PWA
behavior, the wider browser/viewport/axe/visual matrix, and external
staging/provider/alarm/rollback launch gates.

## Dependency rules

- Build shared form primitives before broad profile-form consolidation.
- Build the shared discovery query service before feed UI, venue search, personalization, and replacement matching.
- Build scoped messaging and shared deep links before inbox, notification, and copy promises.
- Complete structured deal terms before immutable snapshots and the runsheet.
- Fix recurrence anchoring before series cancellation and per-occurrence exceptions.
- Establish isolated production-build E2E foundations early; every feature task then adds its permanent journey.

## Phase 1 — Launch correctness

### COR-01 — Review eligibility

- Status: DONE
- Depends on: None
- Completed: 2026-07-20
- Evidence: 248 domain tests; 60 database tests plus 6 optional evaluation skips; 132 web tests; 22 worker tests; full typecheck and production build; isolated Playwright booking-cancellation-review-denial journey.

Acceptance: Reviews are accepted and displayed only for released or genuinely partially completed gigs. Collapsed offers, cancellations, full refunds, active bookings, and unresolved disputes are excluded. One shared domain policy drives API, booking UI, and public reads.

Required tests: Exhaustive state-policy unit test; route positive/negative and no-side-effect matrix; legacy-read defense; permanent two-party cancellation browser regression.

### COR-02 — Recurrence anchor date

- Status: DONE
- Depends on: None
- Completed: 2026-07-30
- Evidence: Venue-local recurrence unit coverage includes weekly, nth/last-weekday, year/month boundaries, spring-forward, and fall-back anchors; real-Postgres series tests cover exact-first materialization and idempotency; the series route persists the selected lower bound; the production Playwright booking journey asserts the selected first night appears exactly once.

Acceptance: The selected first occurrence materializes exactly once. Weekly and monthly dates derive from that anchor in venue local time, and no earlier occurrence appears.

Required tests: Weekly, nth-weekday, last-weekday, month-boundary, and DST unit tests; idempotent materializer integration; create-series browser assertion.

### COR-03 — Cancellation refill candidate restoration

- Status: IN PROGRESS
- Depends on: None
- Implemented: Reopening restores still-eligible passed-over applicants, preserves explicit declines/withdrawals, and exercises transition and worker notification idempotency.
- Remaining acceptance: Add the required multi-applicant cancel-to-rival-offer Playwright journey.

Acceptance: Cancellation reopens the slot, does not prefer the cancelling act, restores still-eligible warm applicants, leaves withdrawn or declined applicants inactive, and emits each urgent notice once.

Required tests: Multi-applicant transition matrix; worker idempotency and notification tests; cancel-to-rival-offer browser journey.

### COR-04 — Complete structured deal terms

- Status: IN PROGRESS
- Depends on: None
- Implemented: Slot/offer terms retain pay, time, provided items, notes, set length where supplied, and venue/act sound inputs; unanswered sound inventory now remains unknown instead of becoming a contradictory zero.
- Remaining acceptance: Complete the structured provision/logistics model, require or deterministically derive set length, persist one non-contradictory sound-plan summary, and add route plus browser required-field/rendered-summary coverage.

Acceptance: Slot and offer terms include structured provisions, required or deterministic set length, and a sound plan that cannot contradict PA inputs.

Required tests: Schema and domain validation; create-slot and offer route tests; browser required-field and rendered-summary assertions.

### COR-05 — Slot expiry and aged-action guards

- Status: DONE
- Depends on: None
- Implemented: Future-only discovery, persistence-boundary guards for posting/applying/offering and sound work, an idempotent expiry sweep, application resolution, and worker/route/database boundary coverage. A retry-safe production browser journey now proves the boot reconciler expires a past open date, removes it from discovery, preserves the performer's truthful expiry outcome, hides apply/offer/invite controls, and rejects stale direct apply, offer, and invite requests.

Acceptance: An open slot expires when its start passes, leaves discovery, and rejects apply, offer, and invite actions. Reads and worker reconciliation agree at the boundary.

Required tests: Injected-clock boundary tests; query and route integration; reconciler idempotency; aged-slot browser case.

### COR-06 — Series cancellation consistency

- Status: IN PROGRESS
- Depends on: COR-02
- Implemented: Series cancellation and one-off closure share an atomic slot/application policy; future open occurrences close, pending applicants receive a truthful outcome, materialization stops, and outstanding firm work blocks the all-or-nothing operation.
- Remaining acceptance: Complete the offered/confirmed/past occurrence route-notification matrix and add the series-cancellation Playwright journey.

Acceptance: Cancelling a series follows an explicit policy for future open, offered, and confirmed occurrences, preserves past occurrences, and leaves no orphan offers.

Required tests: State-by-occurrence database matrix; notification tests; series-cancellation browser journey.

### COR-07 — Tech overlap and active-job uniqueness

- Status: DONE
- Depends on: None
- Completed: 2026-07-30
- Evidence: A database constraint and transactional lock allow one active sound job per parent booking; a per-tech transactional calendar lock rejects every positive interval intersection across confirmed bookings while allowing exact end/start adjacency. Real-Postgres tests cover cancellation/reopening, interval boundaries, and concurrent selections; route tests prove actionable conflict copy and rollback. The retry-safe production Playwright journey creates two same-minute confirmed gigs, books one tech on the first, observes the exact overlap rejection on the second, and reloads to prove its job remains open and its application remains pending.

Acceptance: A tech cannot accept overlapping work or multiple active sound jobs for one parent booking. Cancellation releases availability and concurrent accepts are race-safe.

Required tests: Interval boundary unit tests; concurrency integration; route conflicts; overlap browser rejection.

### COR-08 — Account deactivation consequences

- Status: DONE
- Depends on: None
- Completed: 2026-07-30
- Evidence: The database role/state matrix covers performer, venue, tech, series, application, offer/payment-window, post-gig, and sound states with atomic rollback and race cases; account and admin API/page tests cover active, suspended, reinstated, and deleted behavior. Two retry-safe production Playwright rows cover suspension with a future commitment through owner deactivation, and direct active-account deactivation with no profiles or commitments, including consequence copy, redirect, destroyed session, and durable deleted status in the ops UI.

Acceptance: Every owned role and commitment state is considered. Active commitments either block deactivation with actionable copy or follow a documented resolution path; deactivated records disappear consistently.

Required tests: Role-by-state database matrix; API tests; browser deactivation with and without commitments.

### COR-09 — Immutable terms snapshot

- Status: IN PROGRESS
- Depends on: COR-04
- Implemented: Booking terms lock pay, start/end, venue address, time zone, and template version, and the renderer avoids falling back to later venue location edits.
- Remaining acceptance: Snapshot party names, payment mode, complete structured terms, rendered text, and a deterministic hash; persist and browser-test immutability after every relevant profile edit.

Acceptance: Offers store party names, payment mode, complete structured terms, rendered text, template version, and hash. Later profile changes cannot alter the booking receipt.

Required tests: Deterministic renderer and hash tests; persistence and immutability integration; agreement route and browser regression.

## Phase 2 — Test and CI foundations

### QA-01 — Production-build E2E server

- Status: DONE
- Depends on: None
- Completed: 2026-07-30
- Evidence: Playwright launches the production web/worker supervisor directly with Node; readiness waits on the worker marker and database-aware web health; supervisor tests cover missing inputs/artifacts, early child exit, retries, signal handling, graceful escalation, and deliberate startup failure; CI runs `pnpm e2e` through this path.

Acceptance: Playwright starts and tests the production build with readiness checks and graceful teardown.

Required tests: CI smoke run and deliberate startup-failure self-test.

### QA-02 — Isolated E2E database and worker state

- Status: IN PROGRESS
- Depends on: QA-01
- Implemented: Every managed run creates a uniquely named database, migrates and deterministically seeds it before production builds start, and force-drops it on normal exit, failure, or signal; external-base-URL mode remains read-only with respect to local lifecycle.
- Remaining acceptance: Add the explicit suite-twice row/job-count assertion required by this item.

Acceptance: Each run gets an empty schema or database, deterministic seeds, empty queues, and reliable cleanup. Repeated runs do not accrue jobs or rows.

Required tests: Run the suite twice and assert identical counts with no leftover work.

### QA-03 — Durable selectors and unique scenario data

- Status: IN PROGRESS
- Depends on: QA-02
- Implemented: Journeys use dedicated identities and unique/retry-aware markers, role/label queries for actions, and shared constants for the few remaining CSS primitives.
- Remaining acceptance: Replace the remaining CSS/positional selectors with semantic roles or stable test IDs and pass repeated shuffled strict-selector runs.

Acceptance: Browser tests use roles, test IDs, or unique visible identities rather than common budgets or positional selectors.

Required tests: Repeat and shuffled runs in strict-selector mode.

### QA-04 — Permanent journey matrix

- Status: IN PROGRESS
- Depends on: QA-01, QA-02, QA-03
- Implemented: Permanent production-stack journeys cover web post/apply/offer/accept, two-party booking conversation and rebook, direct-invite decline/recovery, sound-job attach, cancellation review denial, post-gig dispute/admin resolution/double-blind reviews, aged-slot expiry/discovery/action consistency, staff suspension through owner deactivation, and direct no-commitment account deactivation.
- Remaining acceptance: Add the omitted standalone auth/OTP, media, series cancellation, cancellation refill, calendar, support, and broader admin rows; payment/SMS rows remain externally gated.

Acceptance: Permanent coverage spans auth, all roles, media, one-off and series creation, discovery, dashboards, scoped messaging, cancellation/refill/review denial, post-gig reviews and disputes, tech work, calendar, deactivation, support, and admin.

Required tests: The Playwright journeys are the deliverable and run in CI; feature tasks add their rows incrementally.

### QA-05 — Accessibility, viewport, browser, and visual matrix

- Status: TODO
- Depends on: QA-01

Acceptance: Axe and keyboard journeys cover 320, 375, 768, and desktop widths; Chromium, Firefox, and WebKit keep reviewed critical-page snapshots.

Required tests: CI matrix with stable baselines and explicitly documented exceptions.

### QA-06 — Staging deployment gate

- Status: IN PROGRESS
- Depends on: QA-04
- Implemented: `deploy-staging` depends on both the build/test and isolated production E2E jobs and performs a post-deploy health check.
- Remaining acceptance: Add a workflow dependency/dry-run assertion and record a successful staging execution after external deployment configuration is supplied.

Acceptance: Staging deployment cannot run unless build, unit, integration, and E2E jobs pass.

Required tests: Workflow dependency assertion and fixture or dry-run workflow test.

### QA-07 — Gemini evaluation CI wiring

- Status: IN PROGRESS
- Depends on: None
- Implemented: The evaluation suite reports a clear, tested skip reason when `GEMINI_API_KEY` is absent.
- Remaining acceptance: Explicitly map the repository secret into a CI evaluation job and test the present-key workflow path; repository secrets are not injected automatically.

Acceptance: The evaluation job receives the configured key and skips with a clear reason when it is absent.

Required tests: Workflow/config tests for present and absent key paths.

### QA-08 — Real infrastructure assertions

- Status: TODO
- Depends on: None

Acceptance: Infrastructure tests synthesize and assert resources and configuration instead of echoing success.

Required tests: Positive synth assertions and at least one invalid-configuration failure.

## Phase 3 — Shared implementation foundations

### FORM-01 — Unique form control IDs

- Status: IN PROGRESS
- Depends on: None
- Implemented: `ApiForm` derives IDs from React `useId`, removing repeated field-name IDs across adjacent and repeated forms; production E2E scopes and exercises the formerly ambiguous one-off/series controls.
- Remaining acceptance: Add the explicit multi-form DOM uniqueness/label-target test and an accessibility assertion for help/error associations.

Acceptance: Every ApiForm instance generates stable unique IDs and correct label, help, and error associations.

Required tests: Render multiple forms together and assert unique IDs and label targets.

### FORM-02 — Required textarea behavior

- Status: IN PROGRESS
- Depends on: None
- Implemented: Required field definitions now pass native `required` semantics to textareas, with a component DOM regression and matching route schema validation.
- Remaining acceptance: Add the browser submit-block case.

Acceptance: Required textarea definitions produce native required semantics and match server validation.

Required tests: Component DOM assertion; request validation; browser submit-block case.

### FORM-03 — Native input and accessible-state plumbing

- Status: IN PROGRESS
- Depends on: FORM-01
- Implemented: Form feedback uses a polite status live region and every mutation disables its initiating control while busy.
- Remaining acceptance: Add field support/tests for min, max, step, autocomplete, inputMode, help/error IDs, `aria-invalid`, and form `aria-busy`, then run keyboard/screen-reader-facing browser assertions.

Acceptance: Field definitions support min, max, step, autocomplete, inputMode, help/error IDs, aria-live, aria-invalid, and form aria-busy.

Required tests: Parameterized render tests and keyboard/screen-reader-facing browser assertions.

### FORM-04 — Clearable optional PATCH values

- Status: IN PROGRESS
- Depends on: None
- Implemented: Field definitions distinguish omitted, empty-string, null, and empty-array values; performer, venue, and tech PATCH schemas/routes persist explicit clears and reload them in integration tests.
- Remaining acceptance: Finish and pass the edit-clear-reload Playwright coverage before marking this complete.

Acceptance: An explicit clear differs from an omitted field, allowing optional profile values to be removed.

Required tests: Serializer unit cases; PATCH integration; browser edit-clear-reload.

### FORM-05 — Typed field definitions and serializers

- Status: TODO
- Depends on: FORM-01, FORM-02, FORM-03, FORM-04

Acceptance: Magic string transformations become typed parse/serialize adapters; invalid field and transform combinations fail at compile time.

Required tests: Adapter table tests and type-level tests.

### FORM-06 — Shared mutation lifecycle

- Status: IN PROGRESS
- Depends on: FORM-03
- Implemented: Shared request handling now clears busy state in `finally`, surfaces readable server/network errors, preserves retry payloads, supports confirmation/reset/success feedback, and has resolved/rejected retry component tests for forms and action buttons.
- Remaining acceptance: Add the permanent browser failure-retry-success and double-submit cases.

Acceptance: Mutations consistently handle success, error, finally, reset, busy state, confirmation, semantic variants, double-submit prevention, and retry.

Required tests: Resolved and rejected component tests; browser failure-retry-success.

### FORM-07 — Shared create and edit profile forms

- Status: TODO
- Depends on: FORM-05, FORM-06

Acceptance: Performer, venue, and tech create/edit surfaces share typed field groups without label or validation drift.

Required tests: Characterization tests before refactor and create/edit parity afterward.

### CORE-01 — Central labels and terminology

- Status: IN PROGRESS
- Depends on: None
- Implemented: Booking, slot, application, sound-job, gear, party, format, venue-kind, act-kind, and sound-verdict labels are centralized and reused across the edited pages.
- Remaining acceptance: Remove remaining local enum/status wording and add exhaustive mappings plus representative page snapshots.

Acceptance: Enums, statuses, formats, rates, and fallbacks use the central labels module across pages and APIs.

Required tests: Exhaustive enum mapping tests and representative page snapshots.

### CORE-02 — Shared navigation and presentation helpers

- Status: IN PROGRESS
- Depends on: None
- Implemented: Navigation active-state matching and booking, invitation, slot, sound, thread, profile-capability, and profile-label presentation logic now live in focused typed helpers with table tests.
- Remaining acceptance: Consolidate timezone options, auth return links, galleries, breadcrumbs, and every deep-link builder, then add the required URL round-trip/page coverage.

Acceptance: Timezone options, auth return links, galleries, breadcrumbs, and deep links each have one typed implementation.

Required tests: Helper tables, URL encoding and round-trip cases, and representative page tests.

### CORE-03 — Deduplicate identical icons

- Status: TODO
- Depends on: None

Acceptance: Identical SVGs use shared icon components with correct titled and decorative behavior.

Required tests: Icon render and accessibility snapshots plus build/typecheck parity.

### CORE-04 — Canonical Founding Membership state and copy

- Status: TODO
- Depends on: None

Acceptance: Commercial state derives from canonical pricing configuration and one copy source. No page implies an active charge while monetization is off.

Required tests: Commercial-state matrix, role-page copy assertions, and stale-copy repository check.

## Phase 4 — Discovery and marketplace workflow

### DISC-01 — Shared discovery query service

- Status: TODO
- Depends on: None

Acceptance: Pages and APIs use the same typed slot, performer, and venue query services with identical visibility, filters, sort, and pagination.

Required tests: Service integration matrix and API/page parity tests.

### DISC-02 — Complete gig-feed API

- Status: TODO
- Depends on: DISC-01

Acceptance: Date, distance, pay, format, and location filters compose correctly; cursor or page ordering is stable without duplicates or omissions.

Required tests: Filter cross-product integration and pagination boundary cases.

### DISC-03 — Wire discovery UI to filters

- Status: TODO
- Depends on: DISC-02

Acceptance: Controls alter actual results, serialize to the URL, survive refresh/back, support reset, and distinguish empty results from errors.

Required tests: Route-state unit tests and mobile/desktop filter browser journey.

### DISC-04 — Discovery personalization and ranking

- Status: TODO
- Depends on: DISC-01

Acceptance: Eligible results rank by documented distance, fit, recency, and reliability signals without bypassing hard filters; surfaced reasons are understandable.

Required tests: Deterministic ranking fixtures, tie-breaking/property tests, and browser ordering.

### DISC-05 — My listings and My applications

- Status: IN PROGRESS
- Depends on: DISC-01
- Implemented: Owner dashboards expose listing, booking, performer-application, and sound-application history with truthful declined/cancelled outcomes and direct detail actions; historical inactive accounts retain read-only context.
- Remaining acceptance: Add status filters, pagination, complete direct-action coverage, create-to-detail redirect, and the required dashboard browser journey.

Acceptance: Venue listings and performer applications have status filters, pagination, direct actions, and new-slot creation redirects to its detail.

Required tests: Ownership/status query tests and create-to-detail/dashboard browser journeys.

### DISC-06 — Venue search and genre normalization

- Status: TODO
- Depends on: DISC-01

Acceptance: Venue search supports availability, rate, and distance. Genres use one normalized vocabulary with aliases backfilled.

Required tests: Normalization table; migration/query integration; combined-filter browser test.

### DISC-07 — Saved-search UX and alerts

- Status: TODO
- Depends on: DISC-02, CORE-02

Acceptance: Users can create, edit, pause, and delete a saved search from active filters. A matching new slot produces one correctly linked alert.

Required tests: Matcher integration, dedupe/idempotency, notification, and browser lifecycle.

### DISC-08 — Slot-bound direct invitations

- Status: DONE
- Depends on: DISC-01, MSG-01
- Completed: 2026-07-30
- Evidence: Venue search selects a concrete eligible future open date and creates the application plus firm offer transactionally; route tests cover ownership, profile/slot eligibility, reuse/revival, conflicts, rollback, and duplicate prevention; the permanent decline/reapply Playwright journey searches for an act, sends the slot-bound invitation, and exercises the recipient response state.

Acceptance: Invitations name a specific slot, preserve context, expose accept/decline state, and cannot target an ineligible act.

Required tests: Eligibility/state route tests and search-invite-respond browser journey.

### DISC-09 — Favorites and shortlists

- Status: TODO
- Depends on: None

Acceptance: Venues can save acts and privately shortlist applicants per slot; state persists and is owner-scoped.

Required tests: CRUD and uniqueness integration plus browser persistence.

### DISC-10 — Side-by-side applicant comparison

- Status: TODO
- Depends on: DISC-09

Acceptance: Selected applicants compare on consistent profile, media, availability, rate, reliability, and review fields.

Required tests: Comparison view/component matrix and responsive browser snapshot.

### DISC-11 — Replacement broadcast

- Status: TODO
- Depends on: COR-03, DISC-02, DISC-07

Acceptance: After cancellation, matched available acts receive a deduplicated, expiring urgent-fill alert in addition to restored warm applicants.

Required tests: Matcher and worker integration plus notification deep-link browser case.

## Phase 5 — Identity, onboarding, profiles, and media

### ID-01 — Phone linking and verification

- Status: TODO
- Depends on: None

Acceptance: An email user can add or change and verify a phone. Verified state is visible, and SMS features route to and unlock after this flow.

Required tests: OTP route/state tests and link-verify-SMS browser journey.

### ID-02 — Login and OTP UX completeness

- Status: TODO
- Depends on: FORM-03, FORM-06

Acceptance: Login supports resend cooldown, expiry, busy and network states, autocomplete/input mode, accessible OTP focus, and explicit returning-user consent behavior.

Required tests: Fake-clock component tests, route failures, and keyboard/mobile browser journey.

### ONB-01 — Normal-path link ingestion

- Status: TODO
- Depends on: FORM-07

Acceptance: Link ingest is visible in regular performer and tech onboarding. Drafts include media, set lengths, and tech needs, and every inferred value is editable before save.

Required tests: Gateway schema/fallback tests, draft mapping, and edit-before-publish browser journey.

### ONB-02 — Manual structured venue sound setup

- Status: IN PROGRESS
- Depends on: FORM-07
- Implemented: Venue create/edit captures house PA, mixer channels, microphones, monitors, and an explicit yes/no/not-sure operator answer; unknown answers remain unknown through edit and sound-plan evaluation.
- Remaining acceptance: Add the rest of the structured room/setup fields, complete create/edit parity, and automate both manual and AI-assisted edit-before-save browser paths.

Acceptance: Venues can manually enter PA, mixer, channels, mics, monitors, operator, and room setup; AI only proposes editable values.

Required tests: Structured schema and sound-plan fixtures plus manual and AI-assisted browser paths.

### ONB-03 — Tech home location

- Status: TODO
- Depends on: FORM-07

Acceptance: Tech onboarding and editing capture a geocodable home area and travel radius used by discovery.

Required tests: Validation and distance-query integration plus browser persistence.

### ONB-04 — Structured tech rig, rates, and availability

- Status: TODO
- Depends on: ONB-03

Acceptance: Labor-only and with-rig rates have explicit units; equipment is structured; availability supports ranges or recurrence and feeds matching.

Required tests: Schema/rate/availability boundaries and create-edit-search browser journey.

### ONB-05 — Minimum bookable profile completeness

- Status: TODO
- Depends on: FORM-07, ONB-02, ONB-04

Acceptance: Each role has a documented minimum. Incomplete profiles show missing fields and cannot take bookable actions until complete.

Required tests: Role-by-field domain matrix, route guards, and browser completion progression.

### PROF-01 — Performer EPK completeness

- Status: TODO
- Depends on: ONB-05

Acceptance: Public profiles show set lengths, tech needs, rates, availability, meaningful media, and a role-appropriate primary CTA.

Required tests: Profile view-model tests and desktop/mobile browser assertions.

### MEDIA-01 — Media management

- Status: TODO
- Depends on: FORM-06

Acceptance: Owners can list, preview, reorder, caption, replace, and delete media; public order matches saved order and failures preserve edits.

Required tests: Ordering/ownership integration, route cases, and full browser lifecycle.

### MEDIA-02 — Public EPK gallery layout

- Status: TODO
- Depends on: MEDIA-01, PROF-01

Acceptance: Photo, audio, and video render in a coherent responsive gallery with useful empty, loading, and error fallbacks.

Required tests: Component coverage and cross-browser visual snapshots.

## Phase 6 — Booking coordination, communication, and retention

### MSG-01 — Application- and booking-scoped messaging

- Status: IN PROGRESS
- Depends on: None
- Implemented: A firm offer creates/fetches one race-safe booking-scoped conversation in the same transaction; both parties see booking context and can exchange messages in the permanent two-session Playwright journey; legacy rows are worker-backfilled without write-on-read behavior.
- Remaining acceptance: Add first-class application-scoped threads and their route/integration/browser coverage.

Acceptance: Threads are created or found from their application or booking; both parties see the same context and links; generic inquiry threads are not substituted.

Required tests: Scope/participant integration, route tests, and two-session browser journey.

### MSG-02 — Inbox quality

- Status: IN PROGRESS
- Depends on: MSG-01
- Implemented: Inbox selection and display use latest message activity, stable participant/profile labels, counterparty names, previews, and booking context; page/helper tests cover ordering, retained historical labels, and long-thread latest-message behavior.
- Remaining acceptance: Add durable unread/read transitions, pagination beyond current limits, and the ordering browser assertion.

Acceptance: Inbox orders by latest activity, names the right counterparty, shows preview and context, tracks unread state, and paginates consistently.

Required tests: Query fixture matrix, read/unread transitions, and browser ordering.

### MSG-03 — Notification deep links and role copy

- Status: IN PROGRESS
- Depends on: CORE-02, MSG-01
- Implemented: Application, offer, booking, cancellation, expiry, sound-job, account, and message notification routes/copy were aligned with recipient role and actionable subject IDs, with expanded worker template/routing tests.
- Remaining acceptance: Finish the exhaustive template-by-role snapshot and automate delivered email/SMS link routing.

Acceptance: Every notification links to the exact slot, application, booking, or thread and uses actor- and recipient-correct language.

Required tests: Exhaustive template-by-role snapshots and email-link browser routing.

### MSG-04 — Notification preferences and center

- Status: TODO
- Depends on: MSG-03

Acceptance: Users can inspect notifications, mark them read, and choose supported channels by event class; critical reminders state channel limits.

Required tests: Preference routing matrix, center pagination/read tests, and browser changes.

### MSG-05 — Report, block, and mute

- Status: TODO
- Depends on: MSG-01

Acceptance: Users can report records, mute threads, and block counterparties with clear reversible semantics that affect messaging and discovery consistently.

Required tests: Behavior matrix across inquiry/application/booking and browser report/mute/block.

### BOOK-01 — Structured gig logistics

- Status: TODO
- Depends on: COR-04

Acceptance: Load-in, schedule, parking, hospitality, age/accessibility notes, backline, curfew, and day-of contact are structured and visible to appropriate parties.

Required tests: Validation and snapshot tests, offer persistence, and browser edit/read.

### BOOK-02 — Day-of runsheet

- Status: TODO
- Depends on: COR-09, BOOK-01

Acceptance: Confirmed parties get a printable/mobile runsheet built from immutable terms and current logistics with sensible missing-data behavior.

Required tests: Renderer snapshots, role visibility, and mobile/print browser snapshots.

### BOOK-03 — Confirmed contact reveal

- Status: IN PROGRESS
- Depends on: None
- Implemented: One booking-history policy controls contact visibility across active, post-gig, and formerly confirmed cancellation states; unaccepted offers stay hidden and page/helper tests cover retained history.
- Remaining acceptance: Add the required two-party browser transition that proves contacts hidden before and visible after confirmation.

Acceptance: Day-of contact details appear only at the documented confirmed stage and within the coordination surface.

Required tests: Booking-state matrix and two-party browser transition.

### CAL-01 — Visible calendar integration

- Status: IN PROGRESS
- Depends on: CORE-02
- Implemented: A signed iCal feed route with role/state/timezone/location coverage exists for confirmed bookings.
- Remaining acceptance: Expose subscription and per-booking add/download controls in the product, include sound work and availability, and add the browser CTA journey.

Acceptance: Calendar subscription is discoverable; individual bookings support add-to-calendar; feeds include gigs, tech work, and availability with correct timezone/location.

Required tests: iCal parser assertions, role/state matrix, and browser subscription/download CTA.

### SER-01 — Per-occurrence series exceptions

- Status: TODO
- Depends on: COR-02, COR-06

Acceptance: Users can skip or move one date and edit future defaults without rewriting past occurrences or explicit exceptions.

Required tests: Recurrence unit tests, materializer integration, and skip/move/edit-future browser journey.

### RET-01 — Response-time badges

- Status: TODO
- Depends on: None

Acceptance: Response time is defined from canonical events, computed consistently, and displayed only with enough data.

Required tests: Event-time boundary and median tests plus profile/applicant display assertions.

### RET-02 — Booking task grouping

- Status: TODO
- Depends on: CORE-02

Acceptance: Bookings surface actionable tasks grouped by urgency and status with exact links and no completed-task residue.

Required tests: Booking-state task matrix and browser progression.

### PROMO-01 — Maps and sharing

- Status: TODO
- Depends on: CORE-02

Acceptance: Locations open correctly in maps; appropriate public and booking pages offer share actions with fallback and copied-URL feedback.

Required tests: URL encoding/platform cases and browser share/clipboard fallback.

### PROMO-02 — Dynamic social metadata

- Status: IN PROGRESS
- Depends on: None
- Implemented: Live performer, venue, and tech profile routes emit entity-specific title, description, and Open Graph metadata and return not-found metadata for unavailable profiles.
- Remaining acceptance: Add canonical URLs, social-card assets/data, JSON-LD, complete private-page exclusion, metadata snapshots, and crawler-style route assertions.

Acceptance: Public pages have entity-specific title, description, canonical, Open Graph, social-card data, and valid structured data; private pages are excluded.

Required tests: Metadata and JSON-LD snapshots plus crawler-style route assertions.

## Phase 7 — Accessibility, visual design, and copy

### UX-01 — Mobile navigation

- Status: IN PROGRESS
- Depends on: None
- Implemented: Main navigation now exposes correct current-page state, including parent/detail and query-specific routes, with focused active-state tests.
- Remaining acceptance: Add a narrow-width menu, skip link, verified 44px targets/focus treatment, and the keyboard plus 320/375 snapshot matrix.

Acceptance: Narrow widths have a usable menu, at least 44px targets, a skip link, visible focus, and current-page state.

Required tests: Keyboard journey and 320/375 visual snapshots.

### UX-02 — Contrast and control clarity

- Status: TODO
- Depends on: None

Acceptance: Text, placeholders, borders, status colors, and focus states meet the selected AA tokens across states.

Required tests: Axe, token contrast checks, and visual state snapshots.

### UX-03 — Labels for AI, media, and role controls

- Status: IN PROGRESS
- Depends on: FORM-01
- Implemented: Ambiguous act/venue “other” choices and repeated invite/message controls now receive context-specific visible labels, and mutation feedback is announced through a live region.
- Remaining acceptance: Audit AI/media visual controls for names/descriptions/selected state and add keyboard/screen-reader browser assertions.

Acceptance: Icon-only and visual-choice controls have unambiguous accessible names, descriptions, and selected state.

Required tests: Role-query component tests and keyboard/screen-reader browser assertions.

### UX-04 — Multiline, tooltip, and collection semantics

- Status: TODO
- Depends on: None

Acceptance: User text keeps intentional line breaks, essential content is not hover-only, and repeated records use list or table semantics.

Required tests: DOM rendering, keyboard/touch behavior, and axe tests.

### UX-05 — Responsive information layouts

- Status: IN PROGRESS
- Depends on: None
- Implemented: Notices wrap long content, booking action markup no longer nests block notices in paragraphs, and dense booking/sound/inbox records have clearer card hierarchy.
- Remaining acceptance: Complete directory/admin width and preformatted-text review, then pass 320/375/768/desktop overflow assertions and visual snapshots.

Acceptance: Directories and admin use useful width, preformatted text wraps, rich profiles keep hierarchy, and no critical horizontal overflow remains.

Required tests: 320/375/768/desktop snapshots and overflow assertions.

### UX-06 — Authentic venue imagery

- Status: TODO
- Depends on: MEDIA-02

Acceptance: Approved real-room photography replaces generic or empty visual areas with responsive crops and correct alt/decorative treatment.

Required tests: Image presence and alt assertions, performance budget, and visual snapshots.

### UX-07 — Page lifecycle surfaces

- Status: TODO
- Depends on: None

Acceptance: Important routes have tailored loading, error, and not-found states with recovery actions.

Required tests: Component/route failure tests and browser error simulation.

### COPY-01 — Booking-thread claims

- Status: IN PROGRESS
- Depends on: MSG-01
- Implemented: Offer and booking copy now points to the booking-scoped conversation that is created with the firm offer, and distinguishes it from optional generic inquiry messaging.
- Remaining acceptance: Finish application-scoped messaging, then add page assertions and the stale-phrase repository check.

Acceptance: Copy promises an application or booking thread only where that scoped thread exists.

Required tests: Page copy assertions and stale-phrase repository check.

### COPY-02 — Gigit and EightGig naming sweep

- Status: TODO
- Depends on: None

Acceptance: Customer-facing and current operational text consistently uses the selected product name; historical references are explicitly marked.

Required tests: Allow-listed repository naming lint.

### COPY-03 — Consent version and date synchronization

- Status: IN PROGRESS
- Depends on: None
- Implemented: Terms/privacy effective versions, displayed dates, and the consent payload share one source; the verification route test asserts the persisted versions match the published documents.
- Remaining acceptance: Add the browser consent-persistence assertion.

Acceptance: Displayed consent version/date comes from the same source persisted at acceptance.

Required tests: Version mapping and browser consent-persistence tests.

### COPY-04 — Analytics label accuracy

- Status: TODO
- Depends on: DATA-01

Acceptance: Median-ish and similar approximations become exact metrics or are plainly labeled as estimates.

Required tests: Metric and copy assertions.

### COPY-05 — Pay, rate, and timezone terminology

- Status: IN PROGRESS
- Depends on: CORE-01, ONB-04
- Implemented: Edited flows distinguish listed night pay, typical act rate, and tech pay; “time zone” wording and venue-local date labels are substantially aligned through shared helpers.
- Remaining acceptance: Define explicit units for every tech rate, finish the repository-wide mapping, and add representative page assertions.

Acceptance: Pay, budget, and rate wording is context-specific; tech rates include units; timezone language is consistent and local-time aware.

Required tests: Label mapping tests and representative page assertions.

### COPY-06 — Role-choice accessible names

- Status: IN PROGRESS
- Depends on: UX-03
- Implemented: Shared value `other` renders as “Other act” or “Other venue” in the appropriate role form, with a component regression.
- Remaining acceptance: Cover every role-choice control and add the accessible-name browser assertion.

Acceptance: Visible and accessible names distinguish performer, venue, and sound-tech choices without repeated ambiguous labels.

Required tests: Accessible-name component and browser assertions.

### COPY-07 — Other acts and gig-format model

- Status: IN PROGRESS
- Depends on: CORE-01
- Implemented: Act-kind and venue-kind options no longer share an ambiguous global “Other” label; gig-format labels and wildcard behavior are centralized across the edited feed/search paths.
- Remaining acceptance: Settle the product model for “other,” normalize the enum/filter round trip, and add page/browser coverage.

Acceptance: UI copy and enums agree whether other is an act type, entertainment format, or both; posting and search round-trip the same model.

Required tests: Enum mapping/filter round-trip and page copy tests.

### COPY-08 — Editorial readability sweep

- Status: IN PROGRESS
- Depends on: Feature tasks above
- Implemented: Core listing, invitation, booking, cancellation, sound, inbox, account-state, post-gig, and error copy received targeted plain-language corrections backed by helper/page/route assertions.
- Remaining acceptance: Complete onboarding/support and all failure-state review, add the critical-copy allow-list or snapshots, and record manual editorial sign-off.

Acceptance: Core onboarding, posting, applying, booking, cancellation, support, and error copy uses short readable sentences, consistent voice, and no stale promise.

Required tests: Critical-copy snapshots or allow-list plus manual editorial sign-off.

## Phase 8 — Analytics, operations, and launch completion

### DATA-01 — Canonical liquidity metrics

- Status: TODO
- Depends on: None

Acceptance: True median confirmation time and fill rate derive from canonical events, segment by metro, and use rolling eight-week windows.

Required tests: Hand-calculated fixtures plus boundary and timezone cases.

### DATA-02 — Retention and marketplace health metrics

- Status: TODO
- Depends on: None

Acceptance: Venue retention, recurring-series adoption, tech attach rate, and no-show rate have documented numerators, denominators, and dashboard queries.

Required tests: Synthetic cohort/event fixtures including zero denominators.

### DATA-03 — Venue night facts

- Status: IN PROGRESS
- Depends on: None
- Implemented: Gig and quiet-night facts are idempotent and have real-Postgres fixture coverage.
- Remaining acceptance: Derive each fact from the venue-local calendar date (including DST/local-midnight), expose missing windows, and add a backfill/rerun test.

Acceptance: Nightly facts use venue-local dates, are idempotent, and are backfillable for available source history; missing windows are visible.

Required tests: DST/local-midnight fixtures plus backfill and rerun integration.

### DATA-04 — Dashboard presentation

- Status: TODO
- Depends on: DATA-01, DATA-02, DATA-03

Acceptance: Dashboards expose timeframe, metro, sample size, precise labels, and complete empty/loading/error states.

Required tests: Query-to-view snapshots and browser filter journey.

### OPS-01 — Worker heartbeat and dead-man monitoring

- Status: TODO
- Depends on: None

Acceptance: Worker liveness and last-success timestamps are observable; stale processing creates an actionable alert with a runbook link.

Required tests: Fake-clock healthy/stale transitions and deployment smoke check.

### OPS-02 — Deployment rollback or blue-green procedure

- Status: TODO
- Depends on: QA-06

Acceptance: An immutable prior release can be restored without rebuilding; health gates and database compatibility rules are documented and rehearsed.

Required tests: Staging deploy/rollback drill with recorded smoke results.

### OPS-03 — External launch-runbook gates

- Status: TODO
- Depends on: QA-06

Acceptance: AWS deployment verification, email/SMS readiness, and other external non-code prerequisites have owners, evidence, and clear pass/fail state.

Required tests: Scripted post-deploy smoke suite; external checks require recorded evidence.

## Recommended execution order

With COR-01, COR-02, COR-05, COR-07, COR-08, QA-01, and DISC-08 complete, finish the
repeatability and selector acceptance for QA-02/QA-03. Next close the explicit
browser and model gaps on COR-03 and COR-06 while continuing to expand QA-04.
Then complete COR-04 before COR-09 and proceed through the remaining
dependency-ready tasks, adding QA-05 coverage alongside each UI change.
