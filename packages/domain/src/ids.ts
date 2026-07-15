import { ulid } from "ulid";

export type Id<T extends string> = string & { readonly __brand: T };

export type UserId = Id<"user">;
export type RoleId = Id<"role">;
export type PerformerId = Id<"performer">;
export type VenueId = Id<"venue">;
export type TechId = Id<"tech">;
export type SlotId = Id<"slot">;
export type ApplicationId = Id<"application">;
export type BookingId = Id<"booking">;
export type ThreadId = Id<"thread">;
export type MessageId = Id<"message">;
export type MediaId = Id<"media">;
export type SeriesId = Id<"series">;
export type SupportRequestId = Id<"supportRequest">;

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
