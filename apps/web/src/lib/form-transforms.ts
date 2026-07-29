/**
 * Form-body transforms: reshape a flat set of form fields into the nested
 * payload an API route expects (ratings objects, tech-needs / PA-inventory
 * groups, comma-separated lists). Pure and side-effect free so the shapes can
 * be tested directly — the form component only collects values and posts them.
 */

export type FormBody = Record<string, unknown>;

export type TransformName =
  | "ratingsOverall"
  | "ratingsMulti"
  | "genreTagsCsv"
  | "performerProfile"
  | "venueGear";

const RATING_KEYS = [
  "overall",
  "draw",
  "professionalism",
  "quality",
  "hospitality",
  "accuracy",
  "payment",
] as const;

/** "45, 60, x, -3" -> [45, 60]  (positive whole minutes only) */
function csvToPositiveInts(value: string): number[] {
  return value
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Move a group of flat fields into one nested object, dropping the flat keys. */
function collectGroup(
  body: FormBody,
  numberKeys: readonly string[],
  booleanKeys: readonly string[],
): Record<string, number | boolean> {
  const group: Record<string, number | boolean> = {};
  for (const key of numberKeys) {
    if (typeof body[key] === "number") group[key] = body[key] as number;
    delete body[key];
  }
  for (const key of booleanKeys) {
    // selects post strings; an untouched select still means an explicit answer
    if (typeof body[key] === "string") group[key] = body[key] === "true";
    delete body[key];
  }
  return group;
}

/** Apply `transform` to `body` in place and return it. */
export function applyTransform(body: FormBody, transform?: TransformName): FormBody {
  if (transform === "ratingsOverall" && typeof body.overall === "number") {
    body.ratings = { overall: body.overall };
    delete body.overall;
  }

  if (transform === "ratingsMulti") {
    const ratings: Record<string, number> = {};
    for (const key of RATING_KEYS) {
      if (typeof body[key] === "number") {
        ratings[key] = body[key] as number;
        delete body[key];
      }
    }
    body.ratings = ratings;
  }

  if (
    (transform === "genreTagsCsv" || transform === "performerProfile") &&
    typeof body.genreTags === "string"
  ) {
    body.genreTags = body.genreTags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (transform === "performerProfile") {
    if (typeof body.setLengthsMinutes === "string") {
      body.setLengthsMinutes = csvToPositiveInts(body.setLengthsMinutes);
    }
    const techNeeds = collectGroup(
      body,
      ["inputs", "micsNeeded", "monitorsNeeded"],
      ["canPlayUnamplified"],
    );
    if (Object.keys(techNeeds).length > 0) body.techNeeds = techNeeds;
  }

  // The venue's house sound. Before this existed the ONLY writer of
  // paInventory was the AI gear widget on one page, so any venue that never
  // used it kept the {hasPA:false} default — which the public venue page
  // published as "no house PA" and the sound plan read as "tech + rig needed"
  // on every booking. Venues can now state it directly.
  if (transform === "venueGear") {
    const paInventory = collectGroup(
      body,
      ["mixerChannels", "micsAvailable", "monitors"],
      ["hasPA", "hasOperator"],
    );
    if (Object.keys(paInventory).length > 0) body.paInventory = paInventory;
  }

  return body;
}
