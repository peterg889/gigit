import { z } from "zod";

export const performerKinds = ["band", "solo", "comedian", "other"] as const;
export const venueKinds = [
  "bar",
  "restaurant",
  "coffee_shop",
  "brewery",
  "other",
] as const;
export const slotFormats = ["music", "comedy", "either"] as const;

const performerObject = z.object({
  kind: z.enum(performerKinds),
  name: z.string().min(1).max(120),
  bio: z.string().max(4000).default(""),
  genreTags: z.array(z.string().min(1).max(40)).max(10).default([]),
  homeMetro: z.string().min(1).max(80),
  travelRadiusKm: z.number().int().min(0).max(500).default(50),
  rateMinCents: z.number().int().min(0).optional(),
  rateMaxCents: z.number().int().min(0).optional(),
  setLengthsMinutes: z.array(z.number().int().min(10).max(360)).max(5).default([]),
  techNeeds: z
    .object({
      inputs: z.number().int().min(0).max(64).default(0),
      micsNeeded: z.number().int().min(0).max(32).optional(),
      monitorsNeeded: z.number().int().min(0).max(8).optional(),
      canPlayUnamplified: z.boolean().optional(),
    })
    .default({ inputs: 0 }),
});

const rateOk = (v: { rateMinCents?: number | null; rateMaxCents?: number | null }) =>
  v.rateMinCents == null || v.rateMaxCents == null || v.rateMinCents <= v.rateMaxCents;
const rateMsg = { message: "rate floor must be at or below the ceiling", path: ["rateMaxCents"] };
export const performerCreateSchema = performerObject.refine(rateOk, rateMsg);
export const performerUpdateSchema = performerObject.partial().refine(rateOk, rateMsg);

export const venueCreateSchema = z.object({
  kind: z.enum(venueKinds),
  name: z.string().min(1).max(120),
  bio: z.string().max(4000).default(""),
  metro: z.string().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  capacity: z.number().int().min(1).max(5000).optional(),
  paInventory: z
    .object({
      hasPA: z.boolean().default(false),
      mixerChannels: z.number().int().min(0).max(128).optional(),
      micsAvailable: z.number().int().min(0).max(64).optional(),
      monitors: z.number().int().min(0).max(16).optional(),
      hasOperator: z.boolean().optional(),
    })
    .default({ hasPA: false }),
  noiseCurfew: z.string().max(80).optional(),
});
export const venueUpdateSchema = venueCreateSchema.partial();

export const techCreateSchema = z.object({
  name: z.string().min(1).max(120),
  bio: z.string().max(4000).default(""),
  gear: z.enum(["none", "partial", "full_rig"]),
  rateLaborCents: z.number().int().min(0).optional(),
  rateWithRigCents: z.number().int().min(0).optional(),
  travelRadiusKm: z.number().int().min(0).max(500).default(50),
});
export const techUpdateSchema = techCreateSchema.partial();

export const slotCreateSchema = z
  .object({
    startsAt: z.string().datetime(),
    durationMinutes: z.number().int().min(30).max(720),
    format: z.enum(slotFormats),
    genrePrefs: z.array(z.string().min(1).max(40)).max(10).default([]),
    budgetCents: z.number().int().min(1), // budget is REQUIRED: pay transparency is policy
    provides: z
      .object({
        pa: z.boolean().optional(),
        meal: z.boolean().optional(),
        parking: z.boolean().optional(),
      })
      .default({}),
    notes: z.string().max(2000).optional(),
  })
  .refine((s) => new Date(s.startsAt).getTime() > Date.now(), {
    message: "slot must be in the future",
  });

// Recurring series (PRD F2.2): the first occurrence anchors the pattern.
export const seriesCreateSchema = z
  .object({
    startsAt: z.string().datetime(), // first occurrence; weekday/time derive the pattern
    durationMinutes: z.number().int().min(30).max(720),
    freq: z.enum(["weekly", "monthly_dow"]),
    format: z.enum(slotFormats),
    genrePrefs: z.array(z.string().min(1).max(40)).max(10).default([]),
    budgetCents: z.number().int().min(1), // transparency applies to every occurrence
    provides: z
      .object({
        pa: z.boolean().optional(),
        meal: z.boolean().optional(),
        parking: z.boolean().optional(),
      })
      .default({}),
    notes: z.string().max(2000).optional(),
  })
  .refine((s) => new Date(s.startsAt).getTime() > Date.now(), {
    message: "first occurrence must be in the future",
  });

export const applicationCreateSchema = z.object({
  note: z.string().max(1000).optional(),
});

// Tech sub-slot (PRD F6.2): either party funds it; budget shown, as always.
export const techSubslotCreateSchema = z.object({
  payer: z.enum(["venue", "performer"]),
  budgetCents: z.number().int().min(1),
  notes: z.string().max(1000).optional(),
});
export const techSubslotBookSchema = z.object({
  techId: z.string().min(1),
});

// Saved-search alert (PRD F2.3): all fields optional — empty = "any new slot".
export const savedSearchCreateSchema = z.object({
  format: z.enum(slotFormats).optional(),
  metro: z.string().min(1).max(80).optional(),
  minBudgetCents: z.number().int().min(0).optional(),
});

export const offerCreateSchema = z.object({
  amountCents: z.number().int().min(1),
  setLengthMinutes: z.number().int().min(10).max(360).optional(),
  notes: z.string().max(2000).optional(),
});

export const messageCreateSchema = z.object({
  body: z.string().min(1).max(4000),
});

export const inquiryCreateSchema = z
  .object({
    performerId: z.string().min(1).optional(),
    techId: z.string().min(1).optional(),
    slotId: z.string().min(1).optional(),
    body: z.string().min(1).max(4000),
  })
  .refine((v) => !!v.performerId !== !!v.techId, {
    message: "provide exactly one of performerId or techId",
  });

export const reviewCreateSchema = z.object({
  ratings: z
    .record(z.string(), z.number().int().min(1).max(5))
    .refine((r) => typeof r.overall === "number", {
      message: "ratings.overall is required",
    }),
  body: z.string().max(2000).default(""),
});

export const embedCreateSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (u) => /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//.test(u),
      { message: "only YouTube and Vimeo URLs are supported" },
    ),
});

export const authRequestSchema = z
  .object({
    phone: z
      .string()
      .regex(/^\+?[0-9]{10,15}$/)
      .optional(),
    email: z.string().email().optional(),
  })
  .refine((v) => !!v.phone !== !!v.email, {
    message: "provide exactly one of phone or email",
  });

export const authVerifySchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  code: z.string().regex(/^[0-9]{6}$/),
});
