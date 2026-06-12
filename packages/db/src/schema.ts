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

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ── identity ────────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    phone: text("phone"),
    email: text("email"),
    status: text("status").notNull().default("active"), // active | suspended | deleted
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_phone_uq").on(t.phone),
    uniqueIndex("users_email_uq").on(t.email),
  ],
);

export const authOtps = pgTable("auth_otps", {
  id: text("id").primaryKey(),
  destination: text("destination").notNull(), // phone or email
  code: text("code").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

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
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const venues = pgTable("venues", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(), // bar | restaurant | coffee_shop | brewery | other
  name: text("name").notNull(),
  bio: text("bio").notNull().default(""),
  metro: text("metro").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
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
  stripeCustomerId: text("stripe_customer_id"), // saved payment method holder
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
export const slots = pgTable(
  "slots",
  {
    id: text("id").primaryKey(),
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id),
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
  (t) => [index("slots_feed_idx").on(t.status, t.startsAt)],
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

// ── reviews (PRD F7.1: double-blind; from completed platform bookings only) ──
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
  },
  (t) => [
    index("events_outbox_idx").on(t.dispatchedAt),
    index("events_subject_idx").on(t.subjectType, t.subjectId, t.id),
  ],
);
