import { NextResponse } from "next/server";
import type { z } from "zod";

export function ok(data: unknown, init?: number): NextResponse {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function fail(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function parseBody<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<{ data: z.output<S> } | { response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { response: fail("bad_json", "request body must be JSON", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: fail("validation", describeIssues(parsed.error.issues), 422),
    };
  }
  return { data: parsed.data };
}

/**
 * Field names the user would never recognize as the thing they typed. Anything
 * not listed falls through to camelCase-splitting, which handles the majority
 * ("addressLine1" → "Address line 1") without a dictionary entry each.
 */
const FIELD_LABELS: Record<string, string> = {
  amountCents: "Pay",
  budgetCents: "Pay",
  minBudgetCents: "Lowest pay",
  rateLaborCents: "Labor rate",
  rateWithRigCents: "Rate with rig",
  rateMinCents: "Lowest rate",
  rateMaxCents: "Highest rate",
  refundCents: "Refund",
  releaseCents: "Amount to release",
  startsAt: "Date and time",
  durationMinutes: "Set length",
  setLengthMinutes: "Set length",
  setLengthsMinutes: "Set lengths",
  homeMetro: "Home city",
  metro: "City",
  genreTags: "Genres",
  genrePrefs: "Genres you book",
  travelRadiusMiles: "Travel range",
  hasPA: "House PA",
  hasOperator: "House sound tech",
  micsAvailable: "Microphones available",
  micsNeeded: "Microphones needed",
  monitorsNeeded: "Monitors needed",
  mixerChannels: "Mixer channels",
  canPlayUnamplified: "Can play unamplified",
  noiseCurfew: "Noise curfew",
  contentType: "File type",
  imageMimeType: "Image type",
  imageBase64: "Image",
  bytes: "File size",
  termsAccepted: "Terms",
  acceptedTerms: "Terms",
  body: "Message",
  text: "Message",
  code: "Sign-in code",
  freq: "Repeats",
  lat: "Location",
  lng: "Location",
};

function fieldLabel(path: (string | number)[]): string | null {
  const key = path.filter((p) => typeof p === "string").pop();
  if (typeof key !== "string") return null;
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Zod's own wording is written for whoever wrote the schema: raw camelCase
 * paths and "Expected number, received nan". This renders the same problems
 * the way the form asked the question, so a venue owner sees "Pay needs to be
 * a number" instead of "budgetCents: Expected number, received nan".
 */
function describeIssues(issues: z.ZodIssue[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of issues) {
    const label = fieldLabel(issue.path);
    let detail: string;
    if (issue.code === "invalid_type" && issue.received === "undefined")
      detail = label ? `${label} is required.` : "Something required is missing.";
    else if (issue.code === "invalid_type" && issue.expected === "number")
      detail = label ? `${label} needs to be a number.` : "That needs to be a number.";
    else if (issue.code === "too_small")
      detail = label ? `${label} is too short or too low.` : "That value is too small.";
    else if (issue.code === "too_big")
      detail = label ? `${label} is too long or too high.` : "That value is too large.";
    else if (issue.code === "invalid_string" && issue.validation === "email")
      detail = "That doesn't look like an email address.";
    else if (issue.code === "invalid_string" && issue.validation === "url")
      detail = label ? `${label} needs to be a full web address.` : "That needs to be a link.";
    else if (issue.code === "invalid_enum_value" || issue.code === "invalid_union")
      detail = label ? `Pick one of the offered options for ${label}.` : "Pick one of the offered options.";
    else detail = label ? `${label}: ${issue.message}` : issue.message;
    if (!seen.has(detail)) {
      seen.add(detail);
      parts.push(detail);
    }
  }
  return parts.length > 0 ? parts.join(" ") : "Some of those answers need another look.";
}

/**
 * AI-assist failure responses.
 *
 * Every one of these features is a shortcut around a form the user can always
 * fill in by hand, so an outage is a nudge back to the form — not an error. It
 * used to return the exception: with GEMINI_API_KEY unset in an environment,
 * `AiNotConfiguredError.message` is literally "GEMINI_API_KEY is not set", and
 * the widget renders `error.message` verbatim. So the marquee "post a slot in a
 * text message" feature greeted venues with a variable name.
 */
export function aiUnavailable(what: "draft" | "profile" | "gear"): NextResponse {
  const fallback = {
    draft: "Fill the date, pay, and length in below and you're set.",
    profile: "Fill your profile in below — it takes a couple of minutes.",
    gear: "List your equipment in the fields below instead.",
  }[what];
  return fail(
    "ai_unavailable",
    `The assistant isn't available right now. ${fallback}`,
    503,
  );
}
