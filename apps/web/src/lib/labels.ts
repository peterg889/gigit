/**
 * Customer-facing labels for every enum the pages render. One home so the
 * wording can't drift between pages (it already had: "Application sent" vs
 * "Application received", "Other venue" vs "Other").
 */

export const BOOKING_STATE_LABELS: Record<string, string> = {
  offered: "Offer awaiting response",
  confirming: "Confirming booking",
  confirmed: "Confirmed",
  awaiting_confirmation: "Gig played — awaiting confirmation",
  released: "Completed",
  collapsed: "Offer closed",
  disputed: "Under review",
  cancelled_by_venue: "Cancelled by venue",
  cancelled_by_performer: "Cancelled by act",
  refunded: "Cancelled and refunded",
  partially_released: "Resolved",
};

export const SOUND_STATE_LABELS: Record<string, string> = {
  open: "Open",
  booked: "Tech booked",
  released: "Completed",
  cancelled_by_payer: "Cancelled",
  cancelled_with_parent: "Cancelled with gig",
};

/** The tech's view of their own sub-slot application. */
export const SOUND_APPLICATION_LABELS_OWN: Record<string, string> = {
  submitted: "Application sent",
  booked: "Booked",
  declined: "Not selected",
};

/** The payer's view of an applicant on their sub-slot. */
export const SOUND_APPLICATION_LABELS_REVIEW: Record<string, string> = {
  submitted: "Application received",
  booked: "Booked",
  declined: "Not selected",
};

export const GEAR_LABELS: Record<string, string> = {
  none: "Labor only",
  partial: "Partial rig",
  full_rig: "Full PA rig",
};

export const PARTY_LABELS: Record<string, string> = {
  venue: "venue",
  performer: "act",
};

export const GIG_FORMAT_LABEL: Record<string, string> = {
  music: "Live music",
  comedy: "Comedy",
  either: "Music or comedy",
};

export const VENUE_KIND_LABEL: Record<string, string> = {
  bar: "Bar",
  restaurant: "Restaurant",
  coffee_shop: "Coffee shop",
  brewery: "Brewery",
  other: "Other venue",
};

export const ACT_KIND_LABEL: Record<string, string> = {
  band: "Band",
  solo: "Solo act",
  comedian: "Comedian",
  other: "Other act",
};

export const SLOT_STATUS_LABELS: Record<string, string> = {
  draft: "Not yet open",
  open: "Open gig",
  filled: "Booked",
  expired: "Date passed",
  cancelled: "Cancelled",
};

export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  submitted: "Pending",
  withdrawn: "Withdrawn",
  declined: "Not selected",
  offered: "Offer sent",
};

export function friendlyLabel(labels: Record<string, string>, value: string) {
  return labels[value] ?? value.replaceAll("_", " ");
}
