import { ACTIVE_SUBSLOT_STATES } from "@gigit/domain";

export function equipmentCount(
  count: number | undefined,
  singular: string,
  plural = `${singular}s`,
): string {
  if (count == null) return `${singular} count not listed`;
  return `${count} ${count === 1 ? singular : plural}`;
}

export function houseOperatorLabel(value: boolean | undefined): string {
  if (value === true) return "house sound tech included";
  if (value === false) return "no house sound tech";
  return "house sound tech not confirmed";
}

export interface SoundParentAvailability {
  bookingState: string;
  startsAt: Date | string;
  venueProfileStatus: string;
  performerProfileStatus: string;
  venueOwnerStatus: string;
  performerOwnerStatus: string;
}

export interface SoundJobAvailability extends SoundParentAvailability {
  subslotState: string;
}

export interface SoundApplicantAvailability {
  applicationStatus: string;
  techProfileStatus: string;
  techOwnerStatus: string;
  jobIsActionable: boolean;
}

/** The shared parent/profile/account facts behind every sound-job action. */
export function isSoundParentActionable(
  job: SoundParentAvailability,
  now: Date = new Date(),
): boolean {
  const startsAt =
    job.startsAt instanceof Date ? job.startsAt : new Date(job.startsAt);
  return (
    job.bookingState === "confirmed" &&
    Number.isFinite(startsAt.getTime()) &&
    startsAt.getTime() > now.getTime() &&
    job.venueProfileStatus === "live" &&
    job.performerProfileStatus === "live" &&
    job.venueOwnerStatus === "active" &&
    job.performerOwnerStatus === "active"
  );
}

/**
 * An open sub-slot is only actionable while its parent gig and both public
 * parties are still live. The worker closes derived sound work after a parent
 * transition, but server renders must not advertise stale work in that gap.
 */
export function isSoundJobActionable(
  job: SoundJobAvailability,
  now: Date = new Date(),
): boolean {
  return (
    job.subslotState === "open" &&
    isSoundParentActionable(job, now)
  );
}

/**
 * Applicant selection takes the same profile/account facts that the booking
 * transaction locks and rechecks. This prevents a stale control that can only
 * return a conflict after a tech has suspended or hidden their profile.
 */
export function isSoundApplicantBookable(
  applicant: SoundApplicantAvailability,
): boolean {
  return (
    applicant.jobIsActionable &&
    applicant.applicationStatus === "submitted" &&
    applicant.techProfileStatus === "live" &&
    applicant.techOwnerStatus === "active"
  );
}

/** A tech cancellation reopens work, so it needs every live/future parent fact. */
export function isTechSoundCancellationActionable(
  job: SoundJobAvailability,
  now: Date = new Date(),
): boolean {
  return (
    job.subslotState === "booked" &&
    isSoundParentActionable(job, now)
  );
}

/**
 * Payer cancellation closes an existing obligation instead of advertising new
 * work. Keep it available on a confirmed parent even after downbeat or a profile
 * suspension so the payer can close the obligation and settle directly. A
 * closed parent remains stale and is left to its cascade.
 */
export function isPayerSoundCancellationActionable(
  job: SoundJobAvailability,
): boolean {
  return (
    (ACTIVE_SUBSLOT_STATES as readonly string[]).includes(job.subslotState) &&
    job.bookingState === "confirmed"
  );
}

export function payerSoundCancellationConfirmation(
  job: SoundJobAvailability,
  now: Date = new Date(),
): string {
  if (job.subslotState !== "booked")
    return "Cancel this sound job? The listing will close.";
  const startsAt =
    job.startsAt instanceof Date ? job.startsAt : new Date(job.startsAt);
  const hasStarted =
    !Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= now.getTime();
  return hasStarted
    ? "Cancel this sound job? The gig has started and the assignment will close. Settle the agreed sound fee directly with the tech."
    : "Cancel this sound job? The booked tech will be notified and the job will close. Settle any cancellation amount you agreed directly with the tech.";
}

/** Describe the tech's own application from its status and the job outcome. */
export function soundApplicationMessage(input: {
  applicationStatus: string;
  subslotState: string;
  jobIsActionable: boolean;
}): string {
  if (input.applicationStatus === "submitted")
    return input.jobIsActionable
      ? "The paying side has your application and will respond here."
      : "This sound job is no longer open. Your application is being closed.";
  if (input.applicationStatus === "withdrawn")
    return "You withdrew this application.";
  if (input.applicationStatus === "declined") {
    if (input.subslotState === "booked")
      return "The paying side booked another tech for this sound job.";
    if (
      input.subslotState === "cancelled_by_payer" ||
      input.subslotState === "cancelled_with_parent" ||
      input.subslotState === "released"
    )
      return "This sound job closed before you were booked.";
    return "The paying side did not select this application.";
  }
  if (input.applicationStatus === "booked")
    return "You were booked for this sound job, but the assignment has since changed.";
  return "This application has been updated.";
}

/** Describe the tech's selected assignment without promising stale work. */
export function soundAssignmentMessage(input: {
  subslotState: string;
  bookingState: string;
  parentIsActionable: boolean;
}): string {
  if (input.subslotState === "booked") {
    if (input.bookingState !== "confirmed")
      return "The parent booking is no longer active, so this sound assignment is closing.";
    return input.parentIsActionable
      ? "You are the booked tech. Open for load-in details and contacts."
      : "You are still the booked tech for this confirmed gig. Open for assignment details and contacts.";
  }
  if (input.subslotState === "released")
    return "This sound assignment is complete.";
  if (
    input.subslotState === "cancelled_by_payer" ||
    input.subslotState === "cancelled_with_parent"
  )
    return "This sound assignment was cancelled.";
  return "This sound assignment has been updated.";
}
