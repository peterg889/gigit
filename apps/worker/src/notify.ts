/**
 * Notification sink (engineering-spec §10): SMS via Twilio REST, email via
 * SES — each enabled by env, falling back to structured logs in dev.
 * Critical-path templates only at M1; copy lives here, versioned in git.
 */
import { AUTO_CONFIRM_HOURS } from "@gigit/domain";
import { db, emailConfigured, env, paymentsEnabled, schema, smsConfigured } from "@gigit/db";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eq } from "drizzle-orm";

// Voice: docs/brand.md §5 — short sentences, one ask per message, plain on
// the bad path. State what happened, what the policy says, what's next.
const TEMPLATES: Record<string, { subject: string; body: string }> = {
  offer_received: {
    subject: "You got an offer",
    body: "A venue made you an offer. The terms and the pay are here: {url}/bookings",
  },
  booking_confirmed: {
    subject: "It's booked",
    body: "Confirmed and in writing. The money is secured and releases after you play: {url}/bookings",
  },
  offer_expired: {
    subject: "An offer expired",
    body: "An offer ran out before it was accepted. The slot is back on the board: {url}/bookings",
  },
  offer_withdrawn: {
    subject: "An offer was withdrawn",
    body: "The venue withdrew its offer. Nothing owed either way: {url}/bookings",
  },
  offer_declined: {
    subject: "Your offer was declined",
    body: "The performer passed on this offer. The slot is free for another applicant: {url}/bookings",
  },
  payment_failed: {
    subject: "Payment didn't go through",
    body: "The charge for a booking failed, so it isn't confirmed. The slot is back on the board: {url}/bookings",
  },
  booking_account_deactivated: {
    subject: "This booking was cancelled",
    body: "This booking closed because one of the accounts is no longer active. The date is no longer booked. If a payment was still processing, it will be refunded: {url}/bookings",
  },
  account_suspended: {
    subject: "Your EightGig account was suspended",
    body: "Your account is suspended. Your profiles are no longer public, and marketplace actions are unavailable. Any open offers, applications, future venue dates, or active booking or sound commitments were closed. Completed-gig and dispute records were kept. If you think this is a mistake, contact support: {url}/help",
  },
  payment_late_refunded: {
    subject: "Payment refunded",
    body: "The payment completed too late to confirm this booking, so the booking is closed and a full refund is processing: {url}/bookings",
  },
  day_before: {
    subject: "Tomorrow night",
    body: "Gig tomorrow. Set times, contacts, and the terms are all here: {url}/bookings",
  },
  mark_played_prompt: {
    subject: "How'd the night go?",
    body: "Mark the gig played and we'll ask the venue to confirm. The pay releases on its own {autoConfirmHours} hours after the set ends either way: {url}/bookings/{bookingId}",
  },
  performer_marked_played: {
    subject: "The act says the night happened",
    body: "{performerName} marked the gig played. Confirm it and the pay releases now — otherwise it releases on its own {autoConfirmHours} hours after the set ended: {url}/bookings/{bookingId}",
  },
  review_prompt: {
    subject: "How was the night?",
    body: "Leave a review of your gig — it stays private until the other side reviews too, or for {days} days: {url}/bookings/{bookingId}",
  },
  payment_released: {
    subject: "You've been paid",
    body: "The pay for your gig is on its way to your account: {url}/bookings",
  },
  venue_cancelled: {
    subject: "The venue cancelled",
    body: "The venue cancelled the booking. The cancellation policy decides what you're owed, and it's already processing: {url}/bookings",
  },
  performer_cancelled: {
    subject: "The act cancelled",
    body: "The performer cancelled. Your full refund is processing and the slot is back on the board: {url}/bookings",
  },
  dispute_opened: {
    subject: "A dispute was opened",
    body: "We've paused the payout while we look at this. A person reviews it within 5 business days: {url}/bookings",
  },
  dispute_resolved: {
    subject: "Dispute resolved",
    body: "A person reviewed your dispute and made the call. The outcome and the money are here: {url}/bookings",
  },
  slot_reopened: {
    subject: "That night is open again",
    body: "The gig you applied for at this date fell through and it's back on the board — your application is live again, no need to re-apply: {url}/slots/{slotId}",
  },
  application_declined: {
    subject: "That one went to another act",
    body: "The venue booked someone else for this night. Your profile stays ready — here are other open gigs near you: {url}/slots",
  },
  application_not_selected: {
    subject: "The venue passed on your application",
    body: "This venue decided not to move ahead with your application. Your profile stays ready — here are other open gigs: {url}/slots",
  },
  application_expired: {
    subject: "That gig date has passed",
    body: "The night passed without a booking, so your application is closed. Your profile stays ready — here are other open gigs near you: {url}/slots",
  },
  application_cancelled: {
    subject: "That gig date was cancelled",
    body: "The venue took this date off the board, so your application is closed. Your profile stays ready — here are other open gigs: {url}/slots",
  },
  new_application: {
    subject: "An act applied to your slot",
    // Deep link to the slot, where the applicant list and the offer button live.
    // This was a bare {url} — the marketing homepage — on the one email whose
    // whole job is to close the venue funnel.
    body: "New applicant — profile, media, and reviews are all there: {url}/slots/{slotId}",
  },
  new_inquiry: {
    subject: "New inquiry",
    body: "Someone wants to talk about working together. No obligation, reply when you can: {url}/inbox/{threadId}",
  },
  new_message: {
    subject: "New message on EightGig",
    body: "You have a new message waiting: {url}/inbox/{threadId}",
  },
  slot_match: {
    subject: "A slot just posted that fits",
    body: "A new slot matches your alert — pay's on the listing, one tap to apply: {url}/slots/{slotId}",
  },
  new_act: {
    subject: "A new act that fits",
    body: "A new act just joined that fits one of your open slots — take a look and send an invite: {url}/p/{performerId}",
  },
  slot_quiet: {
    subject: "Your slot still needs an act",
    body: "Your open slot hasn't been filled yet — see who's around near you and send an invite: {url}/performers",
  },
  subslot_booked: {
    subject: "Sound is covered",
    body: "The tech is booked. Room specs, input list, and set times are on the booking: {url}/bookings",
  },
  subslot_new_application: {
    subject: "A sound tech applied",
    body: "A tech applied to cover this sound job. Review their profile and application: {url}/sound/{subslotId}",
  },
  subslot_cancelled: {
    subject: "The sound booking was cancelled",
    body: "The cancellation policy decides what's owed, and it's already processing: {url}/bookings",
  },
  subslot_tech_cancelled: {
    subject: "Your tech cancelled",
    body: "Full refund processing. The sound slot is back open for other techs: {url}/bookings",
  },
  subslot_application_declined: {
    subject: "That sound job went to another tech",
    body: "The payer chose another tech for this job. Your profile stays ready — see other open sound jobs: {url}/techs",
  },
  subslot_application_cancelled: {
    subject: "That sound job closed",
    body: "The gig changed or closed before a tech was booked, so your application is closed. See other open sound jobs: {url}/techs",
  },
  act_welcome: {
    // The only message an act gets about itself on day one. Until this existed
    // a new act's email address was used for exactly one thing ever — the
    // sign-in code — and the gig feed it lands on is usually empty, so this is
    // the one channel that can carry it to a bookable profile. Copy is lifted
    // from what the product already says about a media-less page
    // (apps/web/src/app/p/[id]/page.tsx): claiming the page is "ready" would
    // contradict that and defuse its own ask.
    subject: "Your act page is live",
    body: "It's the page you send to a venue, and right now it's just words. A photo and one track do more than any bio — add photos, audio, or video: {url}/me",
  },
  media_rejected: {
    subject: "An upload didn't pass",
    body: "A file you uploaded didn't pass our checks (its contents don't match its type). Try re-exporting and uploading again: {url}/me",
  },
  embed_dead: {
    subject: "A video link went dead",
    body: "One of the videos on your profile no longer plays. Swap it for a live link: {url}/me",
  },
  otp: {
    subject: "Your EightGig sign-in code",
    body: "Your sign-in code is {code}. It expires in 10 minutes. If you didn't ask for it, ignore this.",
  },
  support_escalated: {
    subject: "New EightGig support request",
    body: "A support request needs a person. Open {url}/admin/support/{requestId}",
  },
};

// Discovery-first launch (PAYMENTS_ENABLED off): EightGig moves no gig money, so
// the payment-bearing templates above would lie. These overrides replace them
// with settle-directly copy; the originals return with the payments rail.
const DISCOVERY_OVERRIDES: Record<string, { subject?: string; body: string }> = {
  booking_confirmed: {
    body: "Confirmed and on the books. Set times, contacts, and terms are here — sort the pay with the room directly: {url}/bookings",
  },
  payment_failed: {
    subject: "That booking didn't get confirmed",
    body: "The booking never finished confirming, so it isn't on. The date is back on the board: {url}/bookings",
  },
  payment_late_refunded: {
    subject: "That booking didn't get confirmed",
    body: "This booking could not be confirmed before the date closed, so it is not booked. If you arranged payment directly, contact the other party: {url}/bookings",
  },
  booking_account_deactivated: {
    body: "This booking closed because one of the accounts is no longer active. The date is no longer booked. If you arranged payment directly, contact the other party: {url}/bookings",
  },
  mark_played_prompt: {
    body: "How'd the night go? Mark the gig played and we'll ask the venue to confirm — and square up with the room if you haven't: {url}/bookings/{bookingId}",
  },
  performer_marked_played: {
    body: "{performerName} marked the gig played. Confirm it to close the night out — otherwise it closes on its own {autoConfirmHours} hours after the set ended: {url}/bookings/{bookingId}",
  },
  payment_released: {
    subject: "All wrapped up",
    body: "Your gig's marked complete. If you haven't settled up with the room yet, now's the time: {url}/bookings",
  },
  venue_cancelled: {
    body: "The venue cancelled the booking. No platform money is in play — the slot is back on the board: {url}/bookings",
  },
  performer_cancelled: {
    body: "The performer cancelled. The slot is back on the board for other acts: {url}/bookings",
  },
  dispute_opened: {
    body: "Thanks for flagging this. Reviews stay on hold while a person looks — within 5 business days: {url}/bookings",
  },
  dispute_resolved: {
    body: "A person reviewed the dispute and made the call. The outcome is here: {url}/bookings",
  },
  subslot_cancelled: {
    body: "The sound booking was cancelled. No platform money is in play — the slot is back open: {url}/bookings",
  },
  subslot_tech_cancelled: {
    body: "Your tech cancelled. The sound slot is back open for other techs: {url}/bookings",
  },
};

let ses: SESv2Client | undefined;

export async function notifyBookingParties(
  bookingId: string,
  template: string,
  to: "venue" | "performer" | "both",
  vars: Record<string, string> = {},
): Promise<void> {
  const d = db();
  const [row] = await d
    .select({
      venueOwner: schema.venues.ownerUserId,
      performerOwner: schema.performers.ownerUserId,
      performerName: schema.performers.name,
      venueName: schema.venues.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(
      schema.performers,
      eq(schema.bookings.performerId, schema.performers.id),
    )
    .where(eq(schema.bookings.id, bookingId));
  if (!row) return;
  // Reducer-emitted effects carry no vars, so the names and the deep link have
  // to come from the subject itself or templates render their placeholders raw.
  const subjectVars = {
    bookingId,
    autoConfirmHours: String(AUTO_CONFIRM_HOURS),
    performerName: row.performerName,
    venueName: row.venueName,
    ...vars,
  };
  const userIds =
    to === "both"
      ? [row.venueOwner, row.performerOwner]
      : to === "venue"
        ? [row.venueOwner]
        : [row.performerOwner];
  for (const userId of userIds) await notifyUser(userId, template, subjectVars);
}

/**
 * Which sides of a booking still owe a review — null when both have written
 * one, so a queued prompt for a fully-reviewed gig quietly drops instead of
 * nagging. `reviews_booking_author_uq` makes at most one row per side.
 */
export async function pendingReviewAudience(
  bookingId: string,
): Promise<"venue" | "performer" | "both" | null> {
  const written = new Set(
    (
      await db()
        .select({ role: schema.reviews.authorRole })
        .from(schema.reviews)
        .where(eq(schema.reviews.bookingId, bookingId))
    ).map((r) => r.role),
  );
  const venueOwes = !written.has("venue");
  const performerOwes = !written.has("performer");
  if (venueOwes && performerOwes) return "both";
  if (venueOwes) return "venue";
  if (performerOwes) return "performer";
  return null;
}

/** Sub-slot parties: payer = whichever side funds it; tech if assigned. */
export async function notifySubslotParties(
  subslotId: string,
  template: string,
  to: "payer" | "tech" | "both",
): Promise<void> {
  const d = db();
  const [row] = await d
    .select({
      payer: schema.techSubslots.payer,
      techId: schema.techSubslots.techId,
      venueOwner: schema.venues.ownerUserId,
      performerOwner: schema.performers.ownerUserId,
    })
    .from(schema.techSubslots)
    .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.techSubslots.id, subslotId));
  if (!row) return;

  const payerUser = row.payer === "venue" ? row.venueOwner : row.performerOwner;
  const userIds: string[] = [];
  if (to === "payer" || to === "both") userIds.push(payerUser);
  if ((to === "tech" || to === "both") && row.techId) {
    const [tech] = await d
      .select({ owner: schema.techs.ownerUserId })
      .from(schema.techs)
      .where(eq(schema.techs.id, row.techId));
    if (tech) userIds.push(tech.owner);
  }
  // The subject's own id, so a template can deep-link. Without this any
  // {subslotId} rendered as the literal string.
  for (const userId of userIds)
    await notifyUser(userId, template, { subslotId });
}

/**
 * Every template name. @internal export for copy regressions — a placeholder no
 * caller supplies renders literally in a real email, which is worse than a bad
 * link, so the suite enumerates these rather than trusting review.
 */
export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** Resolve template copy and vars; @internal export for copy regressions. */
export function renderTemplate(
  template: string,
  vars: Record<string, string> = {},
  paymentRailEnabled = paymentsEnabled(),
): { subject: string; body: string } {
  const base = TEMPLATES[template] ?? {
    subject: "EightGig update",
    body: `Update (${template}): {url}`,
  };
  const override = paymentRailEnabled
    ? undefined
    : DISCOVERY_OVERRIDES[template];
  const t = override
    ? { subject: override.subject ?? base.subject, body: override.body }
    : base;
  // {url} plus any per-subject vars (e.g. {slotId}, {code}) → deep links / values.
  const subs: Record<string, string> = { url: env().APP_URL, ...vars };
  let subject = t.subject;
  let body = t.body;
  for (const [k, v] of Object.entries(subs)) {
    subject = subject.replaceAll(`{${k}}`, v);
    body = body.replaceAll(`{${k}}`, v);
  }
  return { subject, body };
}

type NotificationRecipient = {
  id: string;
  status: string;
  email: string | null;
  phone: string | null;
  smsOptedOutAt: Date | null;
};

async function notificationRecipient(
  userId: string,
): Promise<NotificationRecipient | undefined> {
  const [user] = await db()
    .select({
      id: schema.users.id,
      status: schema.users.status,
      email: schema.users.email,
      phone: schema.users.phone,
      smsOptedOutAt: schema.users.smsOptedOutAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return user;
}

async function deliverUserNotification(
  user: NotificationRecipient,
  template: string,
  vars: Record<string, string> = {},
): Promise<void> {
  const t = renderTemplate(template, vars);
  if (user.phone && smsConfigured() && !user.smsOptedOutAt) {
    await sendSms(user.phone, `${t.subject}. ${t.body}`);
  } else if (user.email && emailConfigured()) {
    await sendEmail(user.email, t.subject, t.body);
  } else {
    log("notify.log_sink", { userId: user.id, template, subject: t.subject });
  }
}

export async function notifyUser(
  userId: string,
  template: string,
  vars: Record<string, string> = {},
): Promise<void> {
  const user = await notificationRecipient(userId);
  // Account suspension/deletion can race any outbox lookup. Re-check at the
  // delivery boundary so a user who can no longer act does not receive a stale
  // proactive alert after a matcher or event resolver selected them.
  if (!user || user.status !== "active") return;
  await deliverUserNotification(user, template, vars);
}

/**
 * The one customer-notification path allowed after suspension. It is purposely
 * hard-coded to one template and status rather than exposing an `essential`
 * flag that ordinary alert callers could accidentally use.
 */
export async function notifySuspendedAccount(userId: string): Promise<void> {
  const user = await notificationRecipient(userId);
  if (!user || user.status !== "suspended") return;
  await deliverUserNotification(user, "account_suspended");
}

/**
 * Deliver to a raw destination (a phone or email that may not be a user row
 * yet — e.g. a login code during signup). Picks the channel by destination
 * shape; falls back to the log sink when that channel isn't configured.
 */
export async function notifyDestination(
  destination: string,
  template: string,
  vars: Record<string, string> = {},
): Promise<void> {
  const t = renderTemplate(template, vars);
  const isEmail = destination.includes("@");
  if (!isEmail && smsConfigured()) {
    await sendSms(destination, `${t.subject}. ${t.body}`);
  } else if (isEmail && emailConfigured()) {
    await sendEmail(destination, t.subject, t.body);
  } else {
    // No channel for this destination: in prod this is a dropped login code, so
    // make it loud (the auth route also pre-gates signups to configured channels).
    log(
      env().NODE_ENV === "production" ? "notify.undeliverable" : "notify.log_sink",
      { destination, template, subject: t.subject },
    );
  }
}

/**
 * Support alerts are operational, not best-effort customer notifications.
 * In production a missing mailbox/sender or SES rejection must throw so the
 * outbox retries and eventually dead-letters loudly instead of losing the handoff.
 */
export async function notifySupportOperator(requestId: string): Promise<void> {
  const destination = env().SUPPORT_EMAIL_TO;
  const rendered = renderTemplate("support_escalated", { requestId });
  if (!destination || !emailConfigured()) {
    if (env().NODE_ENV === "production") {
      throw new Error(
        "SUPPORT_EMAIL_TO and EMAIL_FROM are required for support escalation delivery",
      );
    }
    log("notify.log_sink", {
      destination: destination ?? "support-operator",
      template: "support_escalated",
      subject: rendered.subject,
      requestId,
    });
    return;
  }
  await sendEmail(destination, rendered.subject, rendered.body);
}

/** Send the sign-in code for a stored OTP row to its destination (auth flow). */
export async function notifyOtp(otpId: string): Promise<void> {
  if (!otpId) return;
  const [otp] = await db()
    .select({ destination: schema.authOtps.destination, code: schema.authOtps.code })
    .from(schema.authOtps)
    .where(eq(schema.authOtps.id, otpId));
  if (!otp) return;
  await notifyDestination(otp.destination, "otp", { code: otp.code });
}

/** A performer applied to a slot → notify the slot's venue owner. */
export async function notifySlotVenue(slotId: string, template: string): Promise<void> {
  const [row] = await db()
    .select({ owner: schema.venues.ownerUserId })
    .from(schema.slots)
    .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
    .where(eq(schema.slots.id, slotId));
  if (row) await notifyUser(row.owner, template, { slotId });
}

/**
 * A performer-subject event → the act's OWN owner. `performer.created` only
 * ever fanned outward to venues (new_act), so the subject id was never resolved
 * back to `performers.ownerUserId` and the act itself heard nothing.
 */
export async function notifyPerformerOwner(
  performerId: string,
  template: string,
): Promise<void> {
  if (!performerId) return;
  const [row] = await db()
    .select({ owner: schema.performers.ownerUserId })
    .from(schema.performers)
    .where(eq(schema.performers.id, performerId));
  if (row) await notifyUser(row.owner, template);
}

/** An application outcome → the ACT that applied (not the venue). */
export async function notifyApplicationPerformer(
  applicationId: string,
  template: string,
  vars: Record<string, string> = {},
): Promise<void> {
  if (!applicationId) return;
  const [row] = await db()
    .select({ owner: schema.performers.ownerUserId, slotId: schema.applications.slotId })
    .from(schema.applications)
    .innerJoin(schema.performers, eq(schema.applications.performerId, schema.performers.id))
    .where(eq(schema.applications.id, applicationId));
  if (row) await notifyUser(row.owner, template, { slotId: row.slotId, ...vars });
}

/** A sound-job application outcome → the specific tech who applied. */
export async function notifyTechApplicationApplicant(
  applicationId: string,
  template: string,
): Promise<void> {
  if (!applicationId) return;
  const [row] = await db()
    .select({
      owner: schema.techs.ownerUserId,
      subslotId: schema.techSubslotApplications.subslotId,
    })
    .from(schema.techSubslotApplications)
    .innerJoin(
      schema.techs,
      eq(schema.techSubslotApplications.techId, schema.techs.id),
    )
    .where(eq(schema.techSubslotApplications.id, applicationId));
  if (row)
    await notifyUser(row.owner, template, { subslotId: row.subslotId });
}

/** A message/inquiry on a thread → notify every participant except the sender. */
export async function notifyThreadCounterparties(
  threadId: string,
  senderUserId: string,
  template: string,
): Promise<void> {
  const parts = await db()
    .select({ userId: schema.threadParticipants.userId })
    .from(schema.threadParticipants)
    .where(eq(schema.threadParticipants.threadId, threadId));
  for (const p of parts)
    if (p.userId !== senderUserId)
      await notifyUser(p.userId, template, { threadId });
}

async function sendSms(to: string, body: string): Promise<void> {
  const sid = env().TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${env().TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: env().TWILIO_FROM ?? "", Body: body }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    log("notify.sms_failed", { to, status: res.status });
    // A 4xx is our bug (bad number, bad credentials) and will never succeed;
    // burning the retry budget on it just delays the dead-letter. A 5xx or 429
    // is exactly what the outbox retry exists for, so let it through.
    if (res.status >= 500 || res.status === 429)
      throw new Error(`twilio ${res.status}: ${detail.slice(0, 200)}`);
  }
}

/**
 * Deliver, and let failures reach the outbox.
 *
 * This used to swallow every SES error and return normally, so the dispatcher
 * marked the event dispatched and the notification was permanently lost — a
 * throttled send meant nobody was ever told their gig was confirmed, with both
 * the lag and dead-letter alarms staying green. The one caller that wanted a
 * throw passed a flag; now that's the default, and the exceptions are the
 * genuinely best-effort templates. Safe only because the outbox retries with
 * backoff (migration 0024) instead of burning five attempts in milliseconds.
 */
async function sendEmail(
  to: string,
  subject: string,
  body: string,
  bestEffort = false,
): Promise<void> {
  ses ??= new SESv2Client({ region: env().AWS_REGION });
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: env().EMAIL_FROM!,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } } },
      }),
    );
  } catch (err) {
    log("notify.email_failed", { to, err: String(err) });
    if (!bestEffort) throw err;
  }
}

function log(kind: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...data }));
}
