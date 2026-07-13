import { newId } from "@gigit/domain";
import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "./route";

/**
 * SMS router (PRD F2.8): compliance keywords first, then routing. Runs
 * against the dev/CI database; no Twilio signature in test (no auth token).
 */
// unique per run — the dev/CI database accretes test rows by design
const PHONE = `+1555${String(Date.now()).slice(-7)}`;
const STRANGER = `+1444${String(Date.now()).slice(-7)}`;
const userId = newId("user");
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

  it("escapes XML in replies (no TwiML injection)", async () => {
    const xml = await reply(STRANGER, "<script>alert(1)</script>");
    expect(xml).not.toContain("<script>");
  });
});
