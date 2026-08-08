import { newId } from "@gigit/domain";
import { db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "./route";

/**
 * SMS router (PRD F2.8): compliance keywords first, then routing. Runs
 * against the dev/CI database; no Twilio signature in test (no auth token).
 */
// unique per run — the dev/CI database accretes test rows by design
const PHONE = `+1555${String(Date.now()).slice(-7)}`;
const STRANGER = `+1444${String(Date.now()).slice(-7)}`;
const SUPPORT_PHONE = `+1333${String(Date.now()).slice(-7)}`;
const userId = newId("user");
const supportUserId = newId("user");
const venueId = newId("venue");

function smsRequest(from: string, bodyText: string): Request {
  const params = new URLSearchParams({ From: from, Body: bodyText });
  return new Request("http://test/api/webhooks/twilio", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

async function reply(from: string, text: string): Promise<string> {
  const res = await POST(smsRequest(from, text));
  return res.text();
}

describe("inbound SMS router", () => {
  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values({ id: userId, phone: PHONE, email: `${userId}@t.test` });
    await d.insert(schema.users).values({
      id: supportUserId,
      phone: SUPPORT_PHONE,
      email: `${supportUserId}@t.test`,
    });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: userId,
      kind: "bar",
      name: "SMS Test Bar",
      metro: "sms-testville",
      addressLine1: "123 SMS Ave",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      lat: 43,
      lng: -88,
      paInventory: { hasPA: true },
    });
  });

  afterAll(async () => {
    await db()
      .update(schema.users)
      .set({ smsOptedOutAt: null })
      .where(eq(schema.users.id, userId));
  });

  it("HELP returns the help text before any other logic", async () => {
    const xml = await reply(PHONE, "HELP");
    expect(xml).toContain("Opt out: STOP");
    expect(xml).toContain("SUPPORT plus your message");
  });

  it("STOP opts the number out; START opts back in", async () => {
    await reply(PHONE, "STOP");
    let [u] = await db().select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u?.smsOptedOutAt).not.toBeNull();

    await reply(PHONE, "START");
    [u] = await db().select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u?.smsOptedOutAt).toBeNull();
  });

  it("STOP works even for unknown numbers (compliance — never errors)", async () => {
    const xml = await reply(STRANGER, "STOP");
    expect(xml).toContain("unsubscribed");
  });

  it("unknown numbers get the sign-up nudge", async () => {
    const xml = await reply(STRANGER, "hey what is this");
    expect(xml).toContain("don't recognize this number");
  });

  it("venue free-text degrades gracefully when slot parsing is unavailable", async () => {
    // without GEMINI_API_KEY slot_parse throws → the router coaches the format
    const xml = await reply(PHONE, "acoustic friday night two hours $300");
    expect(xml).toMatch(/Couldn't read that one|Reply YES/);
  });

  /**
   * `venues_owner_uq` is unique only WHERE status = 'live', so an owner who
   * deactivated and came back holds a retained hidden row NEXT TO the live one.
   * This route used to take an unordered `rows[0]` between them, and the venue
   * it lands on supplies both the time zone the text is parsed in and the id the
   * night is filed against — so losing that coin flip posted a real gig to a
   * hidden venue at the wrong local time.
   *
   * The hidden row is seeded FIRST and left location-incomplete: an unordered
   * scan returns it, which the router answers with the "add your address" line,
   * making the wrong pick observable without needing slot parsing to be up.
   */
  it("posts against the live venue, not a retained hidden one", async () => {
    const ownerId = newId("user");
    const phone = `+1222${String(Date.now()).slice(-7)}`;
    await db().insert(schema.users).values({
      id: ownerId,
      phone,
      email: `${ownerId}@t.test`,
    });
    await db().insert(schema.venues).values({
      id: newId("venue"),
      ownerUserId: ownerId,
      kind: "bar",
      name: "Retired Room",
      metro: "sms-testville",
      addressLine1: "",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "UTC",
      status: "hidden",
    });
    await db().insert(schema.venues).values({
      id: newId("venue"),
      ownerUserId: ownerId,
      kind: "bar",
      name: "Current Room",
      metro: "sms-testville",
      addressLine1: "500 Live St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      status: "live",
    });

    const xml = await reply(phone, "acoustic friday night two hours $300");
    expect(xml).not.toMatch(/Add your venue address/);
  });

  it("rejects a draft confirmed after its date passes without writing a slot or event", async () => {
    const staleStart = new Date(Date.now() - 60_000).toISOString();
    await db()
      .insert(schema.smsSessions)
      .values({
        phone: PHONE,
        activeContext: {
          kind: "slot_draft",
          venueId,
          draft: {
            startsAt: staleStart,
            durationMinutes: 120,
            format: "music",
            budgetCents: 30_000,
            notes: "Late confirmation regression",
          },
        },
      })
      .onConflictDoUpdate({
        target: schema.smsSessions.phone,
        set: {
          activeContext: {
            kind: "slot_draft",
            venueId,
            draft: {
              startsAt: staleStart,
              durationMinutes: 120,
              format: "music",
              budgetCents: 30_000,
              notes: "Late confirmation regression",
            },
          },
          updatedAt: new Date(),
        },
      });

    const xml = await reply(PHONE, "YES");
    expect(xml).toMatch(/already passed/i);

    const staleSlots = await db()
      .select({ id: schema.slots.id })
      .from(schema.slots)
      .where(
        and(
          eq(schema.slots.venueId, venueId),
          eq(schema.slots.startsAt, new Date(staleStart)),
        ),
      );
    expect(staleSlots).toHaveLength(0);
    const outbox = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actor, userId),
          eq(schema.events.kind, "slot.created"),
          eq(schema.events.subjectType, "slot"),
        ),
      );
    expect(outbox).toHaveLength(0);
    const [session] = await db()
      .select({ activeContext: schema.smsSessions.activeContext })
      .from(schema.smsSessions)
      .where(eq(schema.smsSessions.phone, PHONE));
    expect(session?.activeContext).toBeNull();
  });

  it("lets a venue owner explicitly bypass slot parsing for human support", async () => {
    const message = `I need help with my venue account ${Date.now()}`;
    const xml = await reply(PHONE, `SUPPORT ${message}`);

    expect(xml).toContain("a person will get back to you");
    const [request] = await db()
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.message, message));
    expect(request).toMatchObject({
      requesterUserId: userId,
      contactPhone: PHONE,
      channel: "sms",
      escalationReason: "explicit",
      status: "open",
    });
  });

  it("persists an SMS support escalation for a recognized non-venue user", async () => {
    const message = `I need help changing a booking ${Date.now()}`;
    const xml = await reply(SUPPORT_PHONE, message);

    expect(xml).toContain("<Message>");
    const [request] = await db()
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.requesterUserId, supportUserId));
    expect(request).toMatchObject({
      requesterUserId: supportUserId,
      contactPhone: SUPPORT_PHONE,
      channel: "sms",
      status: "open",
      message,
    });
  });

  it("escapes XML in replies (no TwiML injection)", async () => {
    const xml = await reply(STRANGER, "<script>alert(1)</script>");
    expect(xml).not.toContain("<script>");
  });
});
