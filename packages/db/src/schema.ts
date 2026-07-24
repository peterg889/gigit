import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ── identity ────────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    phone: text("phone"),
    email: text("email"),
    status: text("status").notNull().default("active"), // active | suspended | deleted
    smsOptedOutAt: ts("sms_opted_out_at"), // STOP compliance — no SMS while set
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_phone_uq").on(t.phone),
    uniqueIndex("users_email_uq").on(t.email),
  ],
);

/** Out-of-band role grants (admin). Profile roles live on their own tables. */
export const actorRoles = pgTable(
  "actor_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(), // admin
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("actor_roles_user_kind_uq").on(t.userId, t.kind)],
);

export const authOtps = pgTable(
  "auth_otps",
  {
    id: text("id").primaryKey(),
    destination: text("destination").notNull(), // phone or email
    code: text("code").notNull(),
    attempts: integer("attempts").notNull().default(0),
    requestIp: text("request_ip"), // for per-IP OTP rate limiting (SMS toll-fraud)
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("auth_otps_ip_idx").on(t.requestIp, t.createdAt),
    index("auth_otps_created_idx").on(t.createdAt),
  ],
);

// ── profiles ────────────────────────────────────────────────────────────────
export const performers = pgTable("performers", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(), // band | solo | comedian | other
  name: text("name").notNull(),
  bio: text("bio").notNull().default(""),
  genreTags: jsonb("genre_tags").$type<string[]>().notNull().default([]),
  homeMetro: text("home_metro").notNull(),
  travelRadiusKm: integer("travel_radius_km").notNull().default(50),
  rateMinCents: integer("rate_min_cents"),
  rateMaxCents: integer("rate_max_cents"),
  setLengthsMinutes: jsonb("set_lengths_minutes").$type<number[]>().notNull().default([]),
  techNeeds: jsonb("tech_needs")
    .$type<{
      inputs: number;
      micsNeeded?: number;
      monitorsNeeded?: number;
      canPlayUnamplified?: boolean;
    }>()
    .notNull()
    .default({ inputs: 0 }),
  reliabilityStrikes: integer("reliability_strikes").notNull().default(0),
  status: text("status").notNull().default("live"), // draft | pending_review | live
  stripeAccountId: text("stripe_account_id"), // Connect Express (payout destination)
  // Founding-Member offer: signup rank on the act side, assigned at creation.
  // foundingMember = number <= FOUNDING_LIMIT. Durable record of the promise so
  // it survives to billing time; see packages/db/src/founding.ts.
  foundingNumber: integer("founding_number"),
  foundingMember: boolean("founding_member").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// Split-payout seam (engineering-spec K3: "ledger rows per split from day
// one"). Payouts stay single-target until P1; the table exists so splits are
// never a retrofit.
export const bandMembers = pgTable(
  "band_members",
  {
    id: text("id").primaryKey(),
    performerId: text("performer_id")
      .notNull()
      .references(() => performers.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    payoutSplitBps: integer("payout_split_bps").notNull().default(0), // basis points of the booking amount
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("band_members_uq").on(t.performerId, t.userId)],
);

export const venues = pgTable("venues", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(), // bar | restaurant | coffee_shop | brewery | other
  name: text("name").notNull(),
  bio: text("bio").notNull().default(""),
  metro: text("metro").notNull(),
  addressLine1: text("address_line1").notNull().default(""),
  addressLine2: text("address_line2"),
  city: text("city").notNull().default(""),
  region: text("region").notNull().default(""),
  postalCode: text("postal_code").notNull().default(""),
  timeZone: text("time_zone").notNull().default("UTC"),
  // Null when the metro has no known centroid and no geocoder has run yet;
  // discovery must treat "location unknown" as visible, never as excluded.
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  capacity: integer("capacity"),
  paInventory: jsonb("pa_inventory")
    .$type<{
      hasPA: boolean;
      mixerChannels?: number;
      micsAvailable?: number;
      monitors?: number;
      hasOperator?: boolean;
    }>()
    .notNull()
    .default({ hasPA: false }),
  noiseCurfew: text("noise_curfew"),
  reliabilityStrikes: integer("reliability_strikes").notNull().default(0),
  stripeCustomerId: text("stripe_customer_id"), // saved payment method holder
  defaultPaymentMethodId: text("default_payment_method_id"), // pm_… captured via setup-mode Checkout
  // Founding-Member offer: signup rank on the venue side (see performers).
  foundingNumber: integer("founding_number"),
  foundingMember: boolean("founding_member").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const techs = pgTable("techs", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  bio: text("bio").notNull().default(""),
  gear: text("gear").notNull(), // none | partial | full_rig
  rateLaborCents: integer("rate_labor_cents"),
  rateWithRigCents: integer("rate_with_rig_cents"),
  travelRadiusKm: integer("travel_radius_km").notNull().default(50),
  reliabilityStrikes: integer("reliability_strikes").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    /** which profile this media belongs to */
    subjectType: text("subject_type").notNull(), // performer | venue | tech
    subjectId: text("subject_id").notNull(),
    kind: text("kind").notNull(), // image | audio | video_embed
    storageKey: text("storage_key"),
    bytes: integer("bytes"),
    embedUrl: text("embed_url"),
    embedMeta: jsonb("embed_meta").$type<{ title?: string; thumbnailUrl?: string; provider?: string }>(),
    status: text("status").notNull().default("uploaded"), // uploaded | processing | ready | rejected
    position: integer("position").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("media_subject_idx").on(t.subjectType, t.subjectId)],
);

// ── marketplace ─────────────────────────────────────────────────────────────
// Recurring series (PRD F2.2): a generator whose occurrences are ordinary
// slot rows (materialize-next-N — engineering-spec open question #3 resolved).
export const slotSeries = pgTable("slot_series", {
  id: text("id").primaryKey(),
  venueId: text("venue_id")
    .notNull()
    .references(() => venues.id),
  metro: text("metro").notNull(),
  pattern: jsonb("pattern")
    .$type<{
      freq: "weekly" | "monthly_dow";
      dayOfWeek: number;
      week?: 1 | 2 | 3 | 4 | 5;
      /** Venue wall-clock time. New series always carry this + timeZone. */
      startTimeLocal?: string;
      timeZone?: string;
      /** Compatibility for series created before venue-local recurrence. */
      startTimeUtc?: string;
      durationMinutes: number;
    }>()
    .notNull(),
  defaults: jsonb("defaults")
    .$type<{
      format: string;
      genrePrefs: string[];
      budgetCents: number;
      provides: { pa?: boolean; meal?: boolean; parking?: boolean };
      notes?: string;
    }>()
    .notNull(),
  status: text("status").notNull().default("active"), // active | paused | cancelled
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const slots = pgTable(
  "slots",
  {
    id: text("id").primaryKey(),
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id),
    seriesId: text("series_id").references(() => slotSeries.id),
    metro: text("metro").notNull(),
    startsAt: ts("starts_at").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    format: text("format").notNull(), // music | comedy | either
    genrePrefs: jsonb("genre_prefs").$type<string[]>().notNull().default([]),
    budgetCents: integer("budget_cents").notNull(),
    provides: jsonb("provides")
      .$type<{ pa?: boolean; meal?: boolean; parking?: boolean }>()
      .notNull()
      .default({}),
    notes: text("notes"),
    status: text("status").notNull().default("open"), // draft | open | filled | expired | cancelled
    source: text("source").notNull().default("web"), // web | sms | api
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("slots_feed_idx").on(t.status, t.startsAt),
    // materializer idempotency: one slot per series occurrence
    uniqueIndex("slots_series_occurrence_uq").on(t.seriesId, t.startsAt),
  ],
);

// Saved-search alerts (PRD F2.3): a performer's standing filter; the worker
// matches new slots against these and notifies on slot.created.
export const savedSearches = pgTable(
  "saved_searches",
  {
    id: text("id").primaryKey(),
    performerId: text("performer_id")
      .notNull()
      .references(() => performers.id),
    format: text("format"), // music | comedy | either | null = any
    metro: text("metro"),
    minBudgetCents: integer("min_budget_cents"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("saved_searches_performer_idx").on(t.performerId)],
);

export const applications = pgTable(
  "applications",
  {
    id: text("id").primaryKey(),
    slotId: text("slot_id")
      .notNull()
      .references(() => slots.id),
    performerId: text("performer_id")
      .notNull()
      .references(() => performers.id),
    note: text("note"),
    status: text("status").notNull().default("submitted"), // submitted | withdrawn | declined | offered
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("applications_slot_performer_uq").on(t.slotId, t.performerId)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    slotId: text("slot_id")
      .notNull()
      .references(() => slots.id),
    performerId: text("performer_id")
      .notNull()
      .references(() => performers.id),
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id),
    state: text("state").notNull(), // see domain BOOKING_STATES
    version: integer("version").notNull().default(1),
    terms: jsonb("terms")
      .$type<{
        amountCents: number;
        startsAt: string;
        endsAt: string;
        setLengthMinutes?: number;
        provides?: { pa?: boolean; meal?: boolean; parking?: boolean };
        notes?: string;
        venueAddress?: string;
        timeZone?: string;
      }>()
      .notNull(),
    offerExpiresAt: ts("offer_expires_at").notNull(),
    agreementTemplateVer: text("agreement_template_ver").notNull().default("v1"),
    paymentRef: text("payment_ref"), // PaymentIntent id once charged
    venueAcceptedAt: ts("venue_accepted_at"),
    performerAcceptedAt: ts("performer_accepted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("bookings_performer_idx").on(t.performerId),
    index("bookings_venue_idx").on(t.venueId),
    // One firm offer or engaged booking may hold a slot at a time. The venue
    // must withdraw or let an offer expire before offering another performer; the
    // partial unique index also makes concurrent offer requests safe.
    uniqueIndex("bookings_active_slot_uq")
      .on(t.slotId)
      .where(
        sql`state in ('offered','confirming','confirmed','awaiting_confirmation','disputed','released','partially_released')`,
      ),
  ],
);

// ── comms ───────────────────────────────────────────────────────────────────
export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(), // inquiry | application | booking | support
  subjectId: text("subject_id"), // slot/application/booking id when scoped
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const threadParticipants = pgTable(
  "thread_participants",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [uniqueIndex("thread_participants_uq").on(t.threadId, t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    senderUserId: text("sender_user_id").references(() => users.id),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    body: text("body").notNull(),
    channel: text("channel").notNull().default("app"), // app | sms | email
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)],
);

// ── ai task log (engineering-spec K9: every model call recorded) ────────────
// Fraud flags (PRD F7.5): screening output, consumed by the ops moderation
// queue. `state`: open | cleared | upheld.
export const fraudFlags = pgTable(
  "fraud_flags",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(), // media | performer | venue
    subjectId: text("subject_id").notNull(),
    kind: text("kind").notNull(), // content_type_mismatch | ai_screen | embed_dead | report
    confidence: integer("confidence").notNull(), // 0–100
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").notNull().default("open"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("fraud_flags_state_idx").on(t.state), index("fraud_flags_subject_idx").on(t.subjectType, t.subjectId)],
);

export const aiTasks = pgTable("ai_tasks", {
  id: text("id").primaryKey(),
  taskType: text("task_type").notNull(), // profile_ingest | slot_parse | gear_extract
  actorUserId: text("actor_user_id"),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  model: text("model"), // null = heuristic fallback (no API key)
  promptVersion: text("prompt_version").notNull(),
  status: text("status").notNull(), // done | failed | needs_review
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ── human support queue ─────────────────────────────────────────────────────
// Automated support answers only when the KB is sufficient. Everything else
// lands here so an escalation remains actionable even when email delivery is
// unavailable. Contact values are snapshots: deactivation can later remove
// login identifiers without erasing the reply path from an open request.
export const supportRequests = pgTable(
  "support_requests",
  {
    id: text("id").primaryKey(),
    requesterUserId: text("requester_user_id").references(() => users.id),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    channel: text("channel").notNull(), // web | sms
    category: text("category").notNull().default("other"),
    escalationReason: text("escalation_reason").notNull(), // anonymous | explicit | triage | triage_error | legacy
    message: text("message").notNull(),
    requestIp: text("request_ip"), // set for public (signed-out) submissions; drives their rate limit
    status: text("status").notNull().default("open"), // open | resolved
    claimedByUserId: text("claimed_by_user_id").references(() => users.id),
    claimedAt: ts("claimed_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("support_requests_queue_idx").on(t.status, t.createdAt),
    index("support_requests_requester_idx").on(t.requesterUserId, t.createdAt),
    index("support_requests_ip_idx").on(t.requestIp, t.createdAt),
    index("support_requests_created_idx").on(t.createdAt),
  ],
);

export const supportRequestNotes = pgTable(
  "support_request_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    supportRequestId: text("support_request_id")
      .notNull()
      .references(() => supportRequests.id),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(), // claim | note | resolution
    body: text("body").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("support_request_notes_request_idx").on(t.supportRequestId, t.createdAt),
  ],
);

// ── reviews (PRD F7.1: double-blind; from completed platform bookings only) ──
// ── tech sub-slots (PRD F6.2/F6.3 — the third side on the rails) ────────────
export const techSubslots = pgTable(
  "tech_subslots",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id),
    payer: text("payer").notNull(), // venue | performer (who funds it)
    budgetCents: integer("budget_cents").notNull(), // transparency applies here too
    needs: jsonb("needs")
      .$type<{
        verdict: string;
        gaps: string[];
        inputs: number;
        notes?: string;
      }>()
      .notNull(),
    techId: text("tech_id").references(() => techs.id),
    state: text("state").notNull().default("open"), // domain SubslotState
    version: integer("version").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("tech_subslots_booking_idx").on(t.bookingId), index("tech_subslots_feed_idx").on(t.state)],
);

export const techSubslotApplications = pgTable(
  "tech_subslot_applications",
  {
    id: text("id").primaryKey(),
    subslotId: text("subslot_id")
      .notNull()
      .references(() => techSubslots.id),
    techId: text("tech_id")
      .notNull()
      .references(() => techs.id),
    note: text("note"),
    status: text("status").notNull().default("submitted"), // submitted | booked | declined
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tech_subslot_app_uq").on(t.subslotId, t.techId)],
);

// Double-blind reviews for the derived sound booking. The paying side reviews
// the tech and the tech reviews the working conditions/payer.
export const techSubslotReviews = pgTable(
  "tech_subslot_reviews",
  {
    id: text("id").primaryKey(),
    subslotId: text("subslot_id")
      .notNull()
      .references(() => techSubslots.id),
    authorRole: text("author_role").notNull(), // payer | tech
    ratings: jsonb("ratings").$type<Record<string, number>>().notNull(),
    body: text("body").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tech_subslot_reviews_author_uq").on(t.subslotId, t.authorRole)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id),
    authorRole: text("author_role").notNull(), // venue | performer
    ratings: jsonb("ratings").$type<Record<string, number>>().notNull(),
    body: text("body").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reviews_booking_author_uq").on(t.bookingId, t.authorRole)],
);

// ── money: intent ledger (engineering-spec K3 — append-only) ────────────────
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookingId: text("booking_id").references(() => bookings.id),
    entryType: text("entry_type").notNull(), // charge | release | refund | fee | adjustment
    debitParty: text("debit_party").notNull(), // venue:<id> | platform | performer:<id>
    creditParty: text("credit_party").notNull(),
    amountCents: integer("amount_cents").notNull(),
    paymentRef: text("payment_ref"), // Stripe object id (pi_/tr_/re_) or null_*
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ledger_idem_uq").on(t.idempotencyKey),
    index("ledger_booking_idx").on(t.bookingId),
  ],
);

// ── SMS surface (PRD F2.8, engineering-spec §10) ────────────────────────────
// Conversational state for the inbound router: one row per phone number,
// holding whatever flow is mid-flight (e.g. a parsed slot awaiting "YES").
export const smsSessions = pgTable("sms_sessions", {
  phone: text("phone").primaryKey(),
  activeContext: jsonb("active_context")
    .$type<{
      kind: "slot_draft";
      draft: {
        startsAt: string;
        durationMinutes: number;
        format: string;
        budgetCents: number;
        notes?: string;
      };
      venueId: string;
    } | null>()
    .default(null),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ── ROI-loop baseline (engineering-spec §12, PRD F8.5-P0) ────────────────────
// One row per venue per night, gig or not — the Phase 2 POS comparison joins
// against this. Accrues from MVP because it cannot be backfilled.
export const venueNightFacts = pgTable(
  "venue_night_facts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id),
    nightDate: text("night_date").notNull(), // YYYY-MM-DD (metro-local once TZ lands; UTC at MVP)
    dayOfWeek: integer("day_of_week").notNull(), // 0=Sun … 6=Sat
    hadBooking: boolean("had_booking").notNull().default(false),
    bookingId: text("booking_id").references(() => bookings.id),
    format: text("format"), // music | comedy | either (from the slot)
    budgetCents: integer("budget_cents"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vnf_venue_night_uq").on(t.venueId, t.nightDate)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // provider event id (evt_…)
  provider: text("provider").notNull().default("stripe"),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

// ── events: outbox + audit + analytics (append-only) ────────────────────────
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    actor: text("actor").notNull(), // usr_… | system | worker
    kind: text("kind").notNull(), // e.g. booking.transition, slot.created, notify.queued
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    dispatchedAt: ts("dispatched_at"),
    // Outbox durability: a dispatch that keeps throwing increments attempts and,
    // past the cap, is parked (dead_lettered_at) so it stops wedging the head.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deadLetteredAt: ts("dead_lettered_at"),
  },
  (t) => [
    index("events_outbox_idx").on(t.dispatchedAt),
    index("events_subject_idx").on(t.subjectType, t.subjectId, t.id),
  ],
);
