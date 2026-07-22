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

- Status: TODO
- Depends on: None

Acceptance: The selected first occurrence materializes exactly once. Weekly and monthly dates derive from that anchor in venue local time, and no earlier occurrence appears.

Required tests: Weekly, nth-weekday, last-weekday, month-boundary, and DST unit tests; idempotent materializer integration; create-series browser assertion.

### COR-03 — Cancellation refill candidate restoration

- Status: TODO
- Depends on: None

Acceptance: Cancellation reopens the slot, does not prefer the cancelling act, restores still-eligible warm applicants, leaves withdrawn or declined applicants inactive, and emits each urgent notice once.

Required tests: Multi-applicant transition matrix; worker idempotency and notification tests; cancel-to-rival-offer browser journey.

### COR-04 — Complete structured deal terms

- Status: TODO
- Depends on: None

Acceptance: Slot and offer terms include structured provisions, required or deterministic set length, and a sound plan that cannot contradict PA inputs.

Required tests: Schema and domain validation; create-slot and offer route tests; browser required-field and rendered-summary assertions.

### COR-05 — Slot expiry and aged-action guards

- Status: TODO
- Depends on: None

Acceptance: An open slot expires when its start passes, leaves discovery, and rejects apply, offer, and invite actions. Reads and worker reconciliation agree at the boundary.

Required tests: Injected-clock boundary tests; query and route integration; reconciler idempotency; aged-slot browser case.

### COR-06 — Series cancellation consistency

- Status: TODO
- Depends on: COR-02

Acceptance: Cancelling a series follows an explicit policy for future open, offered, and confirmed occurrences, preserves past occurrences, and leaves no orphan offers.

Required tests: State-by-occurrence database matrix; notification tests; series-cancellation browser journey.

### COR-07 — Tech overlap and active-job uniqueness

- Status: TODO
- Depends on: None

Acceptance: A tech cannot accept overlapping work or multiple active sound jobs for one parent booking. Cancellation releases availability and concurrent accepts are race-safe.

Required tests: Interval boundary unit tests; concurrency integration; route conflicts; overlap browser rejection.

### COR-08 — Account deactivation consequences

- Status: TODO
- Depends on: None

Acceptance: Every owned role and commitment state is considered. Active commitments either block deactivation with actionable copy or follow a documented resolution path; deactivated records disappear consistently.

Required tests: Role-by-state database matrix; API tests; browser deactivation with and without commitments.

### COR-09 — Immutable terms snapshot

- Status: TODO
- Depends on: COR-04

Acceptance: Offers store party names, payment mode, complete structured terms, rendered text, template version, and hash. Later profile changes cannot alter the booking receipt.

Required tests: Deterministic renderer and hash tests; persistence and immutability integration; agreement route and browser regression.

## Phase 2 — Test and CI foundations

### QA-01 — Production-build E2E server

- Status: TODO
- Depends on: None

Acceptance: Playwright starts and tests the production build with readiness checks and graceful teardown.

Required tests: CI smoke run and deliberate startup-failure self-test.

### QA-02 — Isolated E2E database and worker state

- Status: TODO
- Depends on: QA-01

Acceptance: Each run gets an empty schema or database, deterministic seeds, empty queues, and reliable cleanup. Repeated runs do not accrue jobs or rows.

Required tests: Run the suite twice and assert identical counts with no leftover work.

### QA-03 — Durable selectors and unique scenario data

- Status: TODO
- Depends on: QA-02

Acceptance: Browser tests use roles, test IDs, or unique visible identities rather than common budgets or positional selectors.

Required tests: Repeat and shuffled runs in strict-selector mode.

### QA-04 — Permanent journey matrix

- Status: TODO
- Depends on: QA-01, QA-02, QA-03

Acceptance: Permanent coverage spans auth, all roles, media, one-off and series creation, discovery, dashboards, scoped messaging, cancellation/refill/review denial, post-gig reviews and disputes, tech work, calendar, deactivation, support, and admin.

Required tests: The Playwright journeys are the deliverable and run in CI; feature tasks add their rows incrementally.

### QA-05 — Accessibility, viewport, browser, and visual matrix

- Status: TODO
- Depends on: QA-01

Acceptance: Axe and keyboard journeys cover 320, 375, 768, and desktop widths; Chromium, Firefox, and WebKit keep reviewed critical-page snapshots.

Required tests: CI matrix with stable baselines and explicitly documented exceptions.

### QA-06 — Staging deployment gate

- Status: TODO
- Depends on: QA-04

Acceptance: Staging deployment cannot run unless build, unit, integration, and E2E jobs pass.

Required tests: Workflow dependency assertion and fixture or dry-run workflow test.

### QA-07 — Gemini evaluation CI wiring

- Status: TODO
- Depends on: None

Acceptance: The evaluation job receives the configured key and skips with a clear reason when it is absent.

Required tests: Workflow/config tests for present and absent key paths.

### QA-08 — Real infrastructure assertions

- Status: TODO
- Depends on: None

Acceptance: Infrastructure tests synthesize and assert resources and configuration instead of echoing success.

Required tests: Positive synth assertions and at least one invalid-configuration failure.

## Phase 3 — Shared implementation foundations

### FORM-01 — Unique form control IDs

- Status: TODO
- Depends on: None

Acceptance: Every ApiForm instance generates stable unique IDs and correct label, help, and error associations.

Required tests: Render multiple forms together and assert unique IDs and label targets.

### FORM-02 — Required textarea behavior

- Status: TODO
- Depends on: None

Acceptance: Required textarea definitions produce native required semantics and match server validation.

Required tests: Component DOM assertion; request validation; browser submit-block case.

### FORM-03 — Native input and accessible-state plumbing

- Status: TODO
- Depends on: FORM-01

Acceptance: Field definitions support min, max, step, autocomplete, inputMode, help/error IDs, aria-live, aria-invalid, and form aria-busy.

Required tests: Parameterized render tests and keyboard/screen-reader-facing browser assertions.

### FORM-04 — Clearable optional PATCH values

- Status: TODO
- Depends on: None

Acceptance: An explicit clear differs from an omitted field, allowing optional profile values to be removed.

Required tests: Serializer unit cases; PATCH integration; browser edit-clear-reload.

### FORM-05 — Typed field definitions and serializers

- Status: TODO
- Depends on: FORM-01, FORM-02, FORM-03, FORM-04

Acceptance: Magic string transformations become typed parse/serialize adapters; invalid field and transform combinations fail at compile time.

Required tests: Adapter table tests and type-level tests.

### FORM-06 — Shared mutation lifecycle

- Status: TODO
- Depends on: FORM-03

Acceptance: Mutations consistently handle success, error, finally, reset, busy state, confirmation, semantic variants, double-submit prevention, and retry.

Required tests: Resolved and rejected component tests; browser failure-retry-success.

### FORM-07 — Shared create and edit profile forms

- Status: TODO
- Depends on: FORM-05, FORM-06

Acceptance: Performer, venue, and tech create/edit surfaces share typed field groups without label or validation drift.

Required tests: Characterization tests before refactor and create/edit parity afterward.

### CORE-01 — Central labels and terminology

- Status: TODO
- Depends on: None

Acceptance: Enums, statuses, formats, rates, and fallbacks use the central labels module across pages and APIs.

Required tests: Exhaustive enum mapping tests and representative page snapshots.

### CORE-02 — Shared navigation and presentation helpers

- Status: TODO
- Depends on: None

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

- Status: TODO
- Depends on: DISC-01

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

- Status: TODO
- Depends on: DISC-01, MSG-01

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

- Status: TODO
- Depends on: FORM-07

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

- Status: TODO
- Depends on: None

Acceptance: Threads are created or found from their application or booking; both parties see the same context and links; generic inquiry threads are not substituted.

Required tests: Scope/participant integration, route tests, and two-session browser journey.

### MSG-02 — Inbox quality

- Status: TODO
- Depends on: MSG-01

Acceptance: Inbox orders by latest activity, names the right counterparty, shows preview and context, tracks unread state, and paginates consistently.

Required tests: Query fixture matrix, read/unread transitions, and browser ordering.

### MSG-03 — Notification deep links and role copy

- Status: TODO
- Depends on: CORE-02, MSG-01

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

- Status: TODO
- Depends on: None

Acceptance: Day-of contact details appear only at the documented confirmed stage and within the coordination surface.

Required tests: Booking-state matrix and two-party browser transition.

### CAL-01 — Visible calendar integration

- Status: TODO
- Depends on: CORE-02

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

- Status: TODO
- Depends on: None

Acceptance: Public pages have entity-specific title, description, canonical, Open Graph, social-card data, and valid structured data; private pages are excluded.

Required tests: Metadata and JSON-LD snapshots plus crawler-style route assertions.

## Phase 7 — Accessibility, visual design, and copy

### UX-01 — Mobile navigation

- Status: TODO
- Depends on: None

Acceptance: Narrow widths have a usable menu, at least 44px targets, a skip link, visible focus, and current-page state.

Required tests: Keyboard journey and 320/375 visual snapshots.

### UX-02 — Contrast and control clarity

- Status: TODO
- Depends on: None

Acceptance: Text, placeholders, borders, status colors, and focus states meet the selected AA tokens across states.

Required tests: Axe, token contrast checks, and visual state snapshots.

### UX-03 — Labels for AI, media, and role controls

- Status: TODO
- Depends on: FORM-01

Acceptance: Icon-only and visual-choice controls have unambiguous accessible names, descriptions, and selected state.

Required tests: Role-query component tests and keyboard/screen-reader browser assertions.

### UX-04 — Multiline, tooltip, and collection semantics

- Status: TODO
- Depends on: None

Acceptance: User text keeps intentional line breaks, essential content is not hover-only, and repeated records use list or table semantics.

Required tests: DOM rendering, keyboard/touch behavior, and axe tests.

### UX-05 — Responsive information layouts

- Status: TODO
- Depends on: None

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

- Status: TODO
- Depends on: MSG-01

Acceptance: Copy promises an application or booking thread only where that scoped thread exists.

Required tests: Page copy assertions and stale-phrase repository check.

### COPY-02 — Gigit and EightGig naming sweep

- Status: TODO
- Depends on: None

Acceptance: Customer-facing and current operational text consistently uses the selected product name; historical references are explicitly marked.

Required tests: Allow-listed repository naming lint.

### COPY-03 — Consent version and date synchronization

- Status: TODO
- Depends on: None

Acceptance: Displayed consent version/date comes from the same source persisted at acceptance.

Required tests: Version mapping and browser consent-persistence tests.

### COPY-04 — Analytics label accuracy

- Status: TODO
- Depends on: DATA-01

Acceptance: Median-ish and similar approximations become exact metrics or are plainly labeled as estimates.

Required tests: Metric and copy assertions.

### COPY-05 — Pay, rate, and timezone terminology

- Status: TODO
- Depends on: CORE-01, ONB-04

Acceptance: Pay, budget, and rate wording is context-specific; tech rates include units; timezone language is consistent and local-time aware.

Required tests: Label mapping tests and representative page assertions.

### COPY-06 — Role-choice accessible names

- Status: TODO
- Depends on: UX-03

Acceptance: Visible and accessible names distinguish performer, venue, and sound-tech choices without repeated ambiguous labels.

Required tests: Accessible-name component and browser assertions.

### COPY-07 — Other acts and gig-format model

- Status: TODO
- Depends on: CORE-01

Acceptance: UI copy and enums agree whether other is an act type, entertainment format, or both; posting and search round-trip the same model.

Required tests: Enum mapping/filter round-trip and page copy tests.

### COPY-08 — Editorial readability sweep

- Status: TODO
- Depends on: Feature tasks above

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

- Status: TODO
- Depends on: None

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

Finish COR-01, then establish QA-01 through QA-03. Continue with COR-02, COR-03, COR-05, COR-04, COR-09, COR-06, COR-07, and COR-08. Thereafter select dependency-ready tasks phase by phase while expanding QA-04 and QA-05 continuously.

