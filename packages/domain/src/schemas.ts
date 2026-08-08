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

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(isValidTimeZone, "must be a valid IANA time zone");

/** The same normalization metroSchema applies, for deriving a metro from a city. */
export function normalizeMetro(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").slice(0, 80);
}

const metroSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((value) => value.toLocaleLowerCase("en-US"));

const performerObject = z.object({
  kind: z.enum(performerKinds),
  name: z.string().min(1).max(120),
  bio: z.string().max(4000).default(""),
  genreTags: z.array(z.string().min(1).max(40)).max(10).default([]),
  homeMetro: metroSchema,
  travelRadiusMiles: z.number().int().min(0).max(300).default(30),
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

export const performerRateOrderMessage =
  "Lowest rate must be at or below the highest rate.";

export function performerRatesAreOrdered(value: {
  rateMinCents?: number | null;
  rateMaxCents?: number | null;
}): boolean {
  return (
    value.rateMinCents == null ||
    value.rateMaxCents == null ||
    value.rateMinCents <= value.rateMaxCents
  );
}

const rateOrderIssue = {
  message: performerRateOrderMessage,
  path: ["rateMaxCents"],
};
export const performerCreateSchema = performerObject.refine(
  performerRatesAreOrdered,
  rateOrderIssue,
);
export const performerUpdateSchema = performerObject
  .partial()
  .extend({
    // PATCH uses null to explicitly clear a saved bound; omission still means
    // "leave it unchanged".
    rateMinCents: performerObject.shape.rateMinCents.nullable(),
    rateMaxCents: performerObject.shape.rateMaxCents.nullable(),
  })
  .refine(performerRatesAreOrdered, rateOrderIssue);

export const venueCreateSchema = z.object({
  kind: z.enum(venueKinds),
  name: z.string().min(1).max(120),
  bio: z.string().max(4000).default(""),
  // Optional: derived from `city` when not given. Asking for both up front made
  // a venue type "Milwaukee" into two differently-labelled required boxes with
  // ZIP CODE between them. It stays overridable because a suburb venue may want
  // to be found in the Milwaukee scene rather than its own.
  metro: metroSchema.optional(),
  addressLine1: z.string().min(1).max(160),
  addressLine2: z.string().max(160).optional(),
  city: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  postalCode: z.string().min(1).max(20),
  timeZone: timeZoneSchema,
  // Coordinates remain an internal search seam. They are optional until a
  // geocoder is introduced; venue owners should never need to look them up.
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
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
export const venueUpdateSchema = venueCreateSchema.partial().extend({
  capacity: venueCreateSchema.shape.capacity.nullable(),
});

export const techCreateSchema = z.object({
  name: z.string().min(1).max(120),
  bio: z.string().max(4000).default(""),
  gear: z.enum(["none", "partial", "full_rig"]),
  rateLaborCents: z.number().int().min(0).optional(),
  rateWithRigCents: z.number().int().min(0).optional(),
  travelRadiusMiles: z.number().int().min(0).max(300).default(30),
});
export const techUpdateSchema = techCreateSchema.partial().extend({
  rateLaborCents: techCreateSchema.shape.rateLaborCents.nullable(),
  rateWithRigCents: techCreateSchema.shape.rateWithRigCents.nullable(),
});

// A one-off slot and a recurring series describe the same event; only the
// recurrence pattern differs, and it sits in the MIDDLE of the series' field
// list. Hence two groups rather than one: zod reports issues in shape order and
// `describeIssues` concatenates them in that order, so appending `freq` after
// the shared fields would reorder the sentences in a real validation message.
// Kept unexported — index.ts re-exports this module wholesale, and no caller
// outside wants the un-refined shape.
const eventWhenFields = {
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(30).max(720),
};
const eventDetailFields = {
  format: z.enum(slotFormats),
  genrePrefs: z.array(z.string().min(1).max(40)).max(10).default([]),
  // budget is REQUIRED: pay transparency is policy — for a series, that applies
  // to every occurrence.
  budgetCents: z.number().int().min(1),
  provides: z
    .object({
      pa: z.boolean().optional(),
      meal: z.boolean().optional(),
      parking: z.boolean().optional(),
    })
    .default({}),
  notes: z.string().max(2000).optional(),
};

export const slotCreateSchema = z
  .object({ ...eventWhenFields, ...eventDetailFields })
  .refine((s) => new Date(s.startsAt).getTime() > Date.now(), {
    // These refines carry no `path`, so `describeIssues` renders the message
    // alone with no field label in front of it — write them as whole sentences.
    message: "That date has already passed. Pick a date in the future.",
  });

// Recurring series (PRD F2.2): the first occurrence anchors the pattern.
export const seriesCreateSchema = z
  .object({
    ...eventWhenFields, // startsAt is the first occurrence; weekday/time derive the pattern
    freq: z.enum(["weekly", "monthly_dow"]),
    ...eventDetailFields,
  })
  .refine((s) => new Date(s.startsAt).getTime() > Date.now(), {
    message: "The first date has already passed. Pick a date in the future.",
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
  metro: metroSchema.optional(),
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
      message: "pick an overall rating.",
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

/**
 * A sign-in email, folded to lowercase.
 *
 * Every major provider treats the local part case-insensitively, but this code
 * did not: `auth/request` stored the OTP under the address as typed and
 * `auth/verify` looked up the user with `eq(users.email, destination)`, so
 * Foo@x.com and foo@x.com were two different accounts. Signing in with the
 * "wrong" capitalisation silently minted a second account — which, for an admin,
 * means a 403 on /admin with nothing to explain it.
 *
 * Folding here fixes all four consumers at once: the OTP row, the OTP lookup,
 * the user lookup, and the suspension blocklist check.
 */
const signInEmailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLocaleLowerCase("en-US"));

export const authRequestSchema = z
  .object({
    phone: z
      .string()
      .regex(/^\+?[0-9]{10,15}$/)
      .optional(),
    email: signInEmailSchema.optional(),
  })
  .refine((v) => !!v.phone !== !!v.email, {
    message: "provide exactly one of phone or email",
  });

export const authVerifySchema = z
  .object({
    // Same shape and the same exactly-one rule as authRequestSchema. Without
    // them, `{phone: <mine, with a valid code>, email: <someone else's>}` passed
    // validation: the code was checked against the phone, and the user row was
    // then created carrying the OTHER address. Verify has to be at least as
    // strict as request, since it's the half that mints the account.
    phone: z
      .string()
      .regex(/^\+?[0-9]{10,15}$/)
      .optional(),
    email: signInEmailSchema.optional(),
    code: z.string().regex(/^[0-9]{6}$/),
    termsAccepted: z.literal(true),
    source: z.string().trim().min(1).max(80).optional(),
    campaign: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => !!v.phone !== !!v.email, {
    message: "provide exactly one of phone or email",
  });
