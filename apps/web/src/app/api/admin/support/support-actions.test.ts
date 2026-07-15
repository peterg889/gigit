import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as claimPost } from "./[id]/claim/route";
import { POST as notePost } from "./[id]/notes/route";
import { POST as resolvePost } from "./[id]/resolve/route";

type Handler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;
const as = (userId: string | null) => sessionUserId.mockResolvedValue(userId);
const post = (handler: Handler, id: string, body: unknown = {}) =>
  handler(
    new Request(`http://test/api/admin/support/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("admin support workflow", () => {
  const adminA = newId("user");
  const adminB = newId("user");
  const regular = newId("user");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values(
      [adminA, adminB, regular].map((id) => ({
        id,
        email: `${id}@support.test`,
      })),
    );
    await d.insert(schema.actorRoles).values([
      { id: newId("role"), userId: adminA, kind: "admin" },
      { id: newId("role"), userId: adminB, kind: "admin" },
    ]);
  });
  afterAll(async () => {
    await closeDb();
  });

  async function openRequest() {
    const id = newId("supportRequest");
    await db().insert(schema.supportRequests).values({
      id,
      requesterUserId: regular,
      contactEmail: `${regular}@support.test`,
      channel: "web",
      category: "booking",
      escalationReason: "triage",
      message: "The booking details do not match what we discussed.",
    });
    return id;
  }

  it("enforces authentication, admin role, and missing-request handling", async () => {
    const actions: [Handler, unknown][] = [
      [claimPost, {}],
      [notePost, { note: "Internal context." }],
      [resolvePost, { note: "Resolution." }],
    ];

    for (const [handler, body] of actions) {
      const id = await openRequest();
      as(null);
      expect((await post(handler, id, body)).status).toBe(401);
      as(regular);
      expect((await post(handler, id, body)).status).toBe(403);
      as(adminA);
      expect((await post(handler, newId("supportRequest"), body)).status).toBe(404);
    }
  });

  it("supports claim, notes, claimant-only resolution, and immutable closure", async () => {
    const id = await openRequest();
    as(adminA);
    const claimed = await post(claimPost, id);
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      status: "open",
      claimedByUserId: adminA,
    });

    as(adminB);
    expect((await post(claimPost, id)).status).toBe(409);
    expect((await post(resolvePost, id, { note: "Trying to close it." })).status).toBe(409);

    as(adminA);
    expect((await post(notePost, id, { note: "   " })).status).toBe(422);
    expect(
      (
        await post(notePost, id, {
          note: "Confirmed the original listing and contacted the venue.",
        })
      ).status,
    ).toBe(200);
    expect((await post(resolvePost, id, { note: "" })).status).toBe(422);
    const resolved = await post(resolvePost, id, {
      note: "Requester confirmed the corrected booking details.",
    });
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      status: "resolved",
      resolvedByUserId: adminA,
    });
    expect((await post(resolvePost, id, { note: "Again" })).status).toBe(409);
    expect((await post(notePost, id, { note: "Late note" })).status).toBe(409);

    const notes = await db()
      .select()
      .from(schema.supportRequestNotes)
      .where(eq(schema.supportRequestNotes.supportRequestId, id))
      .orderBy(asc(schema.supportRequestNotes.id));
    expect(notes.map((note) => note.kind)).toEqual([
      "claim",
      "note",
      "resolution",
    ]);
    expect(notes.map((note) => note.authorUserId)).toEqual([
      adminA,
      adminA,
      adminA,
    ]);

    const events = await db()
      .select({ kind: schema.events.kind })
      .from(schema.events)
      .where(eq(schema.events.subjectId, id))
      .orderBy(asc(schema.events.id));
    expect(events.map((event) => event.kind)).toEqual([
      "support.claimed",
      "support.note_added",
      "support.resolved",
    ]);
  });
});
