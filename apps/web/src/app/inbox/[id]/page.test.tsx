import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makePerformer, makeUser, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import ThreadPage from "./page";

describe("conversation reply availability", () => {
  let viewerId: string;
  let counterpartId: string;
  let performerId: string;
  const threadId = newId("thread");

  beforeAll(async () => {
    viewerId = await makeUser();
    const performer = await makePerformer({ name: "Read-only Inbox Act" });
    counterpartId = performer.ownerUserId;
    performerId = performer.id;
    await db().insert(schema.threads).values({
      id: threadId,
      scope: "inquiry",
      createdByUserId: viewerId,
    });
    await db().insert(schema.threadParticipants).values([
      { threadId, userId: viewerId },
      { threadId, userId: counterpartId },
    ]);
    await db().insert(schema.messages).values({
      id: newId("message"),
      threadId,
      senderUserId: counterpartId,
      body: "Keep this history visible",
    });
  });

  afterAll(async () => {
    await db().delete(schema.messages).where(eq(schema.messages.threadId, threadId));
    await db()
      .delete(schema.threadParticipants)
      .where(eq(schema.threadParticipants.threadId, threadId));
    await db().delete(schema.threads).where(eq(schema.threads.id, threadId));
    await db().delete(schema.performers).where(eq(schema.performers.id, performerId));
    await db()
      .delete(schema.users)
      .where(inArray(schema.users.id, [viewerId, counterpartId]));
    vi.unstubAllGlobals();
    await closeDb();
  });

  async function renderThread() {
    sessionUserId.mockResolvedValue(viewerId);
    return renderToStaticMarkup(
      await ThreadPage({ params: Promise.resolve({ id: threadId }) }),
    );
  }

  it("shows Reply only while every participant account is active", async () => {
    const active = await renderThread();
    expect(active).toContain("Keep this history visible");
    expect(active).toContain(">Reply<");
    expect(active).toContain(">Send<");
    expect(active).not.toContain("Replies unavailable");

    for (const status of ["suspended", "deleted"] as const) {
      await db()
        .update(schema.users)
        .set({ status })
        .where(eq(schema.users.id, counterpartId));
      const readOnly = await renderThread();
      expect(readOnly).toContain("Keep this history visible");
      expect(readOnly).toContain("Replies unavailable");
      expect(readOnly).toContain(
        "another participant&#x27;s account is no longer active",
      );
      expect(readOnly).not.toContain(">Reply<");
      expect(readOnly).not.toContain(">Send<");
    }

    await db()
      .update(schema.users)
      .set({ status: "active" })
      .where(eq(schema.users.id, counterpartId));
  });
});
