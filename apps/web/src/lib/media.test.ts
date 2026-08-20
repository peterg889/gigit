import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

import { ownedMedia } from "./media";

async function attach(
  subjectType: "performer" | "venue" | "tech",
  subjectId: string,
  ownerUserId: string,
  row: { kind: string; status: string; title?: string; position?: number },
) {
  const id = newId("media");
  await db().insert(schema.mediaAssets).values({
    id,
    ownerUserId,
    subjectType,
    subjectId,
    kind: row.kind,
    embedUrl: `https://youtu.be/${id}`,
    embedMeta: row.title ? { title: row.title, provider: "youtube" } : {},
    status: row.status,
    position: row.position ?? 0,
  });
  return id as string;
}

/**
 * The owner's own view of their media, which is not the public one: /p, /v and
 * /t all filter on status = 'ready', and reusing that filter here would hide the
 * held link the owner is trying to delete and leave them adding a duplicate of
 * something they already have.
 */
describe("ownedMedia", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("shows the owner the links a public page hides, and only their own profile's", async () => {
    const userId = newId("user");
    const mine = newId("performer");
    const someoneElse = newId("performer");
    await db().insert(schema.users).values({ id: userId, email: `${userId}@t.test` });
    await db()
      .insert(schema.performers)
      .values([
        { id: mine, ownerUserId: userId, kind: "band", name: "Mine", homeMetro: "mke" },
      ]);
    const readyId = await attach("performer", mine, userId, {
      kind: "video",
      status: "ready",
      title: "Live set",
    });
    const heldId = await attach("performer", mine, userId, {
      kind: "video",
      status: "held",
      position: 1,
    });
    const blockedId = await attach("performer", mine, userId, {
      kind: "video",
      status: "blocked",
      position: 2,
    });
    // Same owner user, different profile row: the pairing the DELETE route
    // authorizes on is (subject_type, subject_id), so the list has to be built
    // on the same pairing or it offers a Remove the route then refuses.
    await attach("performer", someoneElse, userId, { kind: "photo", status: "ready" });

    const rows = await ownedMedia("performer", mine);

    expect(rows.map((r) => r.id)).toEqual([readyId, heldId, blockedId]);
    expect(rows.map((r) => r.status)).toEqual(["ready", "held", "blocked"]);
    // No oEmbed title came back for the held one; the caller renders the URL.
    expect(rows[0]!.title).toBe("Live set");
    expect(rows[1]!.title).toBeNull();
  });
});
