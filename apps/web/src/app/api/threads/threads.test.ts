import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
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
