import { ulid } from "ulid";

/**
 * The brand on `newId`'s return type. Thirteen per-entity aliases (`UserId`,
 * `VenueId`, …) used to sit here; none was ever imported anywhere, because ids
 * cross the Drizzle boundary as plain `text` columns and come back as `string`.
 * The brand that survives is the one doing work — it keeps `newId("venue")`
 * from being silently accepted where a slot id belongs.
 */
export type Id<T extends string> = string & { readonly __brand: T };

const prefixes = {
  user: "usr",
  role: "rol",
  performer: "prf",
  venue: "ven",
  tech: "tec",
  slot: "slt",
  application: "app",
  booking: "bkg",
  thread: "thr",
  message: "msg",
  media: "med",
  series: "srs",
  search: "sch",
  supportRequest: "spr",
} as const;

export function newId<K extends keyof typeof prefixes>(kind: K): Id<K> {
  return `${prefixes[kind]}_${ulid()}` as Id<K>;
}
