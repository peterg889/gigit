import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeUser,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import InboxPage from "./page";

describe("inbox activity ordering", () => {
  let viewerId: string;
  let actOwnerId: string;
  let performerId: string;
  let threadIds: string[];

  beforeAll(async () => {
    viewerId = await makeUser();
    const performer = await makePerformer({
      name: "Inbox Act",
    });
    actOwnerId = performer.ownerUserId;
    performerId = performer.id;
    threadIds = Array.from({ length: 51 }, () => newId("thread"));
    await db()
      .insert(schema.threads)
      .values(
        threadIds.map((id, index) => ({
          id,
          scope: "inquiry",
          createdByUserId: viewerId,
          createdAt: new Date(Date.UTC(2020, 0, index + 1)),
        })),
      );
    await db()
      .insert(schema.threadParticipants)
      .values(
        threadIds.flatMap((threadId) => [
          { threadId, userId: viewerId },
          { threadId, userId: actOwnerId },
        ]),
      );
    await db().insert(schema.messages).values([
      {
        id: newId("message"),
        threadId: threadIds[0]!,
        senderUserId: viewerId,
        body: "LATEST THREAD",
        createdAt: new Date(),
      },
      {
        id: newId("message"),
        threadId: threadIds[1]!,
        senderUserId: viewerId,
        body: "STALE THREAD",
        createdAt: new Date(Date.UTC(2020, 0, 2)),
      },
    ]);
  });

  afterAll(async () => {
    const d = db();
    await d.delete(schema.messages).where(inArray(schema.messages.threadId, threadIds));
    await d
      .delete(schema.threadParticipants)
      .where(inArray(schema.threadParticipants.threadId, threadIds));
    await d.delete(schema.threads).where(inArray(schema.threads.id, threadIds));
    await d.delete(schema.performers).where(eq(schema.performers.id, performerId));
    await d
      .delete(schema.users)
      .where(inArray(schema.users.id, [viewerId, actOwnerId]));
    vi.unstubAllGlobals();
    await closeDb();
  });

  it("keeps a recently replied-to old thread inside the 50-row inbox", async () => {
    sessionUserId.mockResolvedValue(viewerId);
    const html = renderToStaticMarkup(await InboxPage());

    expect(html).toContain("LATEST THREAD");
    expect(html).not.toContain("STALE THREAD");
    expect(html).toContain("Inbox Act");
  });
});
