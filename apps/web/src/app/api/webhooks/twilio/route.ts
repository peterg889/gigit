import crypto from "node:crypto";
import { newId } from "@gigit/domain";
import { appendEvent, db, env, schema, slotParse, supportTriage } from "@gigit/db";
import { eq } from "drizzle-orm";

/**
 * Inbound SMS router (PRD F2.8, engineering-spec §10). Order is compliance-
 * mandated: STOP/HELP first, then active-context replies, then slot parsing
 * for venue numbers, then the support fallback.
 *
 * Replies are TwiML. Externally gated on A2P 10DLC registration (runbook).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  // Signature verification (Twilio: HMAC-SHA1 over URL + sorted form params).
  const token = env().TWILIO_AUTH_TOKEN;
  if (token) {
    const sig = req.headers.get("x-twilio-signature") ?? "";
    const url = `${env().APP_URL}/api/webhooks/twilio`;
    const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const payload = url + sorted.map(([k, v]) => k + v).join("");
    const expected = crypto.createHmac("sha1", token).update(payload).digest("base64");
    const ok =
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return new Response("bad signature", { status: 403 });
  }
  // No token configured = dev only; the route is unreachable in prod without it.

  const from = params.get("From") ?? "";
  const body = (params.get("Body") ?? "").trim();
  const reply = await route(from, body);
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${
      reply ? `<Message>${escapeXml(reply)}</Message>` : ""
    }</Response>`,
    { headers: { "content-type": "text/xml" } },
  );
}

async function route(phone: string, body: string): Promise<string | null> {
  const d = db();
  const upper = body.toUpperCase();

  // 1. Compliance keywords — before any other logic, always.
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(upper)) {
    await d
      .update(schema.users)
      .set({ smsOptedOutAt: new Date() })
      .where(eq(schema.users.phone, phone));
    return "You're unsubscribed from Gigit texts. Reply START to turn them back on.";
  }
  if (upper === "START" || upper === "UNSTOP") {
    await d
      .update(schema.users)
      .set({ smsOptedOutAt: null })
      .where(eq(schema.users.phone, phone));
    return "You're back on. We only text what matters: offers, confirmations, day-of details.";
  }
  if (upper === "HELP" || upper === "INFO") {
    return "Gigit — live music, comedy & sound for small rooms. Venues: text what you need ('acoustic Friday, $300'). Help: reply here. Opt out: STOP.";
  }

  const [user] = await d.select().from(schema.users).where(eq(schema.users.phone, phone));
  if (!user) {
    return "This is Gigit. We don't recognize this number — sign up at gigit and add your phone, then texting works.";
  }

  const [venue] = await d
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.ownerUserId, user.id));

  // 2. Active context: a slot draft awaiting confirmation.
  const [session] = await d
    .select()
    .from(schema.smsSessions)
    .where(eq(schema.smsSessions.phone, phone));
  if (session?.activeContext?.kind === "slot_draft") {
    if (["YES", "Y", "POST", "POST IT", "CONFIRM"].includes(upper)) {
      const { draft, venueId } = session.activeContext;
      const slotId = newId("slot");
      const [v] = await d.select().from(schema.venues).where(eq(schema.venues.id, venueId));
      await d.insert(schema.slots).values({
        id: slotId,
        venueId,
        metro: v?.metro ?? "unknown",
        startsAt: new Date(draft.startsAt),
        durationMinutes: draft.durationMinutes,
        format: draft.format,
        genrePrefs: [],
        budgetCents: draft.budgetCents,
        provides: {},
        notes: draft.notes ?? null,
        source: "sms",
      });
      await appendEvent(d, {
        actor: user.id,
        kind: "slot.created",
        subjectType: "slot",
        subjectId: slotId,
        payload: { venueId, source: "sms" },
      });
      await clearSession(phone);
      return `Posted: ${summarize(draft)}. We'll text you when acts apply.`;
    }
    if (["NO", "N", "CANCEL THAT", "NEVERMIND"].includes(upper)) {
      await clearSession(phone);
      return "Scrapped. Text the night again whenever you're ready.";
    }
    // anything else while a draft is pending = a re-parse with the new text
  }

  // 3. Venue numbers: plain-English slot posting.
  if (venue && body.length >= 5) {
    try {
      const draft = await slotParse(body, user.id);
      if (draft.clarificationNeeded) {
        return `One thing first: ${draft.clarificationNeeded}`;
      }
      if (!draft.budgetCents || draft.budgetCents < 1) {
        return "What's the pay? Every Gigit slot shows its budget — that's why good acts apply.";
      }
      await d
        .insert(schema.smsSessions)
        .values({
          phone,
          activeContext: { kind: "slot_draft", draft, venueId: venue.id },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.smsSessions.phone,
          set: {
            activeContext: { kind: "slot_draft", draft, venueId: venue.id },
            updatedAt: new Date(),
          },
        });
      return `Got it: ${summarize(draft)}. Reply YES to post it, NO to scrap it.`;
    } catch {
      return "Couldn't read that one. Try like: 'something chill for Sunday brunch, two hours, $200'.";
    }
  }

  // 4. Support (F9.4): KB-grounded answers reply instantly; the rest
  // escalates to a person. Either way the message is on the record.
  try {
    const triage = await supportTriage(body, user.id);
    if (triage.escalate)
      await appendEvent(d, {
        actor: user.id,
        kind: "support.escalated",
        subjectType: "user",
        subjectId: user.id,
        payload: { body: body.slice(0, 500), category: triage.category, channel: "sms" },
      });
    return triage.reply;
  } catch {
    await appendEvent(d, {
      actor: user.id,
      kind: "support.escalated",
      subjectType: "user",
      subjectId: user.id,
      payload: { body: body.slice(0, 500), channel: "sms" },
    });
    return "Got your message — a person will get back to you.";
  }
}

async function clearSession(phone: string) {
  await db()
    .update(schema.smsSessions)
    .set({ activeContext: null, updatedAt: new Date() })
    .where(eq(schema.smsSessions.phone, phone));
}

function summarize(d: {
  startsAt: string;
  durationMinutes: number;
  format: string;
  budgetCents: number;
}): string {
  const when = new Date(d.startsAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${d.format}, ${when} UTC, ${d.durationMinutes} min, $${(d.budgetCents / 100).toFixed(0)}`;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
