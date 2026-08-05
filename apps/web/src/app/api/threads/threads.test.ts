import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { GET as listThreads, POST as openInquiry } from "./route";
import { GET as getMessages, POST as postMessage } from "./[id]/messages/route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const inquiry = (body: Record<string, unknown>) =>
  openInquiry(
    new Request("http://test/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const message = (threadId: string, body: string) =>
  postMessage(
    new Request(`http://test/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    { params: Promise.resolve({ id: threadId }) },
  );
const readMessages = (threadId: string) =>
  getMessages(new Request(`http://test/t`), {
    params: Promise.resolve({ id: threadId }),
  });

/**
 * Messaging is scoped and directional (F5.1): venues open inquiries to
 * performers/techs, performers only to techs, and only participants can read
 * or post in a thread. None of that had a test.
 */
describe("threads and messages", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const uTech = newId("user");
  const uStranger = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [uVenue, uBand, uTech, uStranger].map((id) => ({ id, email: `${id}@t.test` })),
      );
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Thread Bar",
      metro: "thread-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Thread Band",
      homeMetro: "thread-tv",
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: uTech,
      name: "Thread Tech",
      gear: "full_rig",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  it("venue opens an inquiry to a performer; both participants can talk, strangers cannot", async () => {
    as(uVenue);
    const res = await inquiry({ performerId, body: "Friday free?" });
    expect(res.status).toBe(201);
    const { threadId } = await res.json();

    // recipient can read and reply
    as(uBand);
    expect((await readMessages(threadId)).status).toBe(200);
    expect((await message(threadId, "yes!")).status).toBe(201);

    // a stranger can do neither
    as(uStranger);
    expect((await readMessages(threadId)).status).toBe(403);
    expect((await message(threadId, "let me in")).status).toBe(403);

    // messages persisted in order for participants
    as(uVenue);
    const msgs = await (await readMessages(threadId)).json();
    expect(msgs.messages.map((m: { body: string }) => m.body)).toEqual([
      "Friday free?",
      "yes!",
    ]);
  });

  it("rolls back a message when its outbox event cannot be written", async () => {
    as(uVenue);
    const opened = await inquiry({ performerId, body: "Atomic thread" });
    const { threadId } = await opened.json();
    const functionName = `fail_message_event_${threadId.slice(-12).toLowerCase()}`;
    const triggerName = `${functionName}_trigger`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.subject_id = '${threadId}' and new.kind = 'message.sent' then
          raise exception 'forced message event failure';
        end if;
        return new;
      end
      $$
    `);
    await pool.query(`
      create trigger ${triggerName}
      before insert on events
      for each row execute function ${functionName}()
    `);
    try {
      await expect(message(threadId, "Must roll back")).rejects.toThrow();
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }
    const rows = await db()
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId));
    expect(rows).toEqual([{ body: "Atomic thread" }]);
  });

  it("does not add a message when another participant is no longer active", async () => {
    as(uVenue);
    const opened = await inquiry({ performerId, body: "Before deactivation" });
    const { threadId } = await opened.json();
    await db()
      .update(schema.users)
      .set({ status: "deleted" })
      .where(eq(schema.users.id, uBand));
    try {
      const response = await message(threadId, "Are you there?");
      expect(response.status).toBe(409);
    } finally {
      await db()
        .update(schema.users)
        .set({ status: "active" })
        .where(eq(schema.users.id, uBand));
    }
    const rows = await db()
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId));
    expect(rows).toEqual([{ body: "Before deactivation" }]);
  });

  it("the daily cap counts inquiries you sent, not ones you received", async () => {
    // The cap joined through participants, so inbound inquiries counted against
    // your own send budget. Anyone holding both a venue and an act profile —
    // which onboarding actively invites — could be locked out having sent
    // nothing, and it never cleared while their inbox stayed busy.
    const d = db();
    const uBoth = newId("user");
    const bothVenue = newId("venue");
    const bothPerformer = newId("performer");
    await d.insert(schema.users).values({ id: uBoth, email: `${uBoth}@t.test` });
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: bothVenue, ownerUserId: uBoth, kind: "bar", name: "Both Bar",
      metro: "thread-tv", lat: 43, lng: -88,
    });
    await d.insert(schema.performers).values({
      id: bothPerformer, ownerUserId: uBoth, kind: "solo", name: "Both Act",
      homeMetro: "thread-tv",
    });

    // 12 venues each open an inquiry to their act — well past the cap of 10
    for (let i = 0; i < 12; i++) {
      const threadId = newId("thread");
      await d.insert(schema.threads).values({
        id: threadId,
        scope: "inquiry",
        createdByUserId: uVenue, // someone ELSE authored these
      });
      await d.insert(schema.threadParticipants).values([
        { threadId, userId: uVenue },
        { threadId, userId: uBoth },
      ]);
    }

    // having sent zero, they can still send
    as(uBoth);
    const res = await inquiry({ techId, body: "Free Friday?" });
    expect(res.status).toBe(201);
  });

  it("performer cannot cold-message a performer (only techs)", async () => {
    as(uBand);
    const res = await inquiry({ performerId, body: "hey rival band" });
    expect(res.status).toBe(403);
  });

  it("performer can open an inquiry to a tech", async () => {
    as(uBand);
    const res = await inquiry({ techId, body: "need sound for a bar gig" });
    expect(res.status).toBe(201);
  });

  it("rejects hidden and deactivated recipients without creating a thread", async () => {
    const before = await db()
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.createdByUserId, uVenue));
    as(uVenue);

    await db()
      .update(schema.performers)
      .set({ status: "hidden" })
      .where(eq(schema.performers.id, performerId));
    try {
      const hidden = await inquiry({ performerId, body: "Still there?" });
      expect(hidden.status).toBe(409);
    } finally {
      await db()
        .update(schema.performers)
        .set({ status: "live" })
        .where(eq(schema.performers.id, performerId));
    }

    await db()
      .update(schema.users)
      .set({ status: "deleted" })
      .where(eq(schema.users.id, uBand));
    try {
      const deleted = await inquiry({ performerId, body: "Still there?" });
      expect(deleted.status).toBe(409);
    } finally {
      await db()
        .update(schema.users)
        .set({ status: "active" })
        .where(eq(schema.users.id, uBand));
    }

    const after = await db()
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.createdByUserId, uVenue));
    expect(after).toHaveLength(before.length);
  });

  it("returns a clean conflict when a multi-role user targets their own profile", async () => {
    const userId = newId("user");
    const ownVenueId = newId("venue");
    const ownPerformerId = newId("performer");
    await db().insert(schema.users).values({
      id: userId,
      email: `${userId}@t.test`,
    });
    await db().insert(schema.venues).values({
      id: ownVenueId,
      ownerUserId: userId,
      kind: "bar",
      name: "Self Message Room",
      metro: "thread-tv",
      lat: 43,
      lng: -88,
      addressLine1: "2 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await db().insert(schema.performers).values({
      id: ownPerformerId,
      ownerUserId: userId,
      kind: "solo",
      name: "Self Message Act",
      homeMetro: "thread-tv",
    });

    as(userId);
    const res = await inquiry({
      performerId: ownPerformerId,
      body: "Message myself",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "self_inquiry", message: "You can't message your own profile." },
    });
    const rows = await db()
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.createdByUserId, userId));
    expect(rows).toHaveLength(0);
  });

  it("a user with no profile at all cannot open inquiries", async () => {
    as(uStranger);
    const res = await inquiry({ performerId, body: "hi" });
    expect(res.status).toBe(403);
  });

  it("thread list shows only the caller's threads", async () => {
    as(uStranger);
    const res = await listThreads();
    const { threads } = await res.json();
    expect(threads).toEqual([]);
  });
});
