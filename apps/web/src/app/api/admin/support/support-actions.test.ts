import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { and, asc, eq } from "drizzle-orm";
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

/**
 * A raw pooled connection, borrowed from @gigit/db's own pool (apps/web must
 * not depend on `pg`). Used only to hold a row lock so a race is deterministic.
 */
interface BarrierClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

/**
 * Block until `expected` backends are parked on a support_requests lock. Bounded
 * so a barrier that never engages fails the test instead of hanging the suite.
 */
async function waitForBlockedClaims(
  client: BarrierClient,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await client.query(
      `select count(*)::int as blocked
         from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%support_requests%'`,
    );
    if (Number(rows[0]!.blocked) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `fewer than ${expected} claims blocked on the row lock — the concurrency ` +
      "barrier never engaged, so this test would prove nothing",
  );
}

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

  /**
   * The whole reason the claim is a CONDITIONAL update (`status = 'open' AND
   * claimed_by IS NULL` in the WHERE, then `if (!claimed) → 409`) rather than a
   * read-then-write is the two-admin race: the queue page is a shared screen
   * and two people grab the top row in the same second. A sequential second
   * claim is passed by a TOCTOU read-then-write too — its SELECT sees the
   * committed claim — so only genuinely concurrent requests can tell the two
   * implementations apart. Both admins winning is not a cosmetic bug: the
   * requester gets worked twice, and the claim note + `support.claimed` event
   * are the audit trail ops uses to say who owned the ticket.
   */
  it("lets exactly one of two concurrent claims win, with one note and one event", async () => {
    const id = await openRequest();
    // Firing both handlers with Promise.all is NOT enough: the first request's
    // connection is already warm while the second is still being established,
    // so it runs to COMMIT before the second's SELECT even lands. That version
    // was measured to pass with the conditional update replaced by a
    // read-then-write, i.e. it asserts nothing. Holding the row from a third
    // connection forces the overlap that does happen in production: both
    // requests get past their read, then park on the same row lock, and only
    // the WHERE clause decides who wins.
    const barrier = (await getPool().connect()) as unknown as BarrierClient;
    // The watcher must be its OWN connection outside any transaction:
    // pg_stat_activity is snapshot-cached per transaction (stats_fetch_
    // consistency defaults to 'cache'), so polling it from the barrier's open
    // transaction returns the same frozen answer forever and never sees the
    // claims arrive.
    const watcher = (await getPool().connect()) as unknown as BarrierClient;
    let first: Response;
    let second: Response;
    try {
      await barrier.query("begin");
      await barrier.query(
        "select id from support_requests where id = $1 for update",
        [id],
      );

      // Two distinct admins on two in-flight requests: `sessionUserId` is
      // consumed once per request (requireUser → requireAdmin), so queueing two
      // one-shot values hands each request its own identity.
      sessionUserId.mockResolvedValueOnce(adminA).mockResolvedValueOnce(adminB);
      const claims = Promise.all([post(claimPost, id), post(claimPost, id)]);

      await waitForBlockedClaims(watcher, 2);
      await barrier.query("rollback");
      [first, second] = await claims;
    } finally {
      // Belt and braces: a pooled client released mid-transaction keeps its row
      // lock, which would wedge every later test on this database.
      await barrier.query("rollback").catch(() => {});
      barrier.release();
      watcher.release();
    }
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winnerResponse = first.status === 200 ? first : second;
    const loserResponse = first.status === 200 ? second : first;
    const winner = (await winnerResponse.json()) as { claimedByUserId: string };
    await expect(loserResponse.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    expect([adminA, adminB]).toContain(winner.claimedByUserId);

    // The row itself agrees with the response the winner got: no last-write-wins
    // overwrite by the admin who was told 409.
    const [row] = await db()
      .select({
        claimedByUserId: schema.supportRequests.claimedByUserId,
        status: schema.supportRequests.status,
      })
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.id, id));
    expect(row!.claimedByUserId).toBe(winner.claimedByUserId);
    expect(row!.status).toBe("open");

    // The loser must write NOTHING. One claim note, one event, both the
    // winner's — a second of either is what a read-then-write would leave.
    const notes = await db()
      .select({
        kind: schema.supportRequestNotes.kind,
        authorUserId: schema.supportRequestNotes.authorUserId,
      })
      .from(schema.supportRequestNotes)
      .where(eq(schema.supportRequestNotes.supportRequestId, id));
    expect(notes).toEqual([
      { kind: "claim", authorUserId: winner.claimedByUserId },
    ]);

    const claimedEvents = await db()
      .select({ actor: schema.events.actor })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, id),
          eq(schema.events.kind, "support.claimed"),
        ),
      );
    expect(claimedEvents).toEqual([{ actor: winner.claimedByUserId }]);
  });
});
