import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const create = (name: string) =>
  POST(
    new Request("http://test/api/techs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        bio: "",
        gear: "partial",
        travelRadiusMiles: 30,
      }),
    }),
  );

describe("sound-tech profile creation", () => {
  const concurrentOwnerId = newId("user");
  const rollbackOwnerId = newId("user");

  beforeAll(async () => {
    await db().insert(schema.users).values([
      {
        id: concurrentOwnerId,
        email: `${concurrentOwnerId}@tech-create.test`,
      },
      {
        id: rollbackOwnerId,
        email: `${rollbackOwnerId}@tech-create.test`,
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns one created profile and one clean conflict for a double submit", async () => {
    sessionUserId.mockResolvedValue(concurrentOwnerId);
    const responses = await Promise.all([
      create("Concurrent Tech A"),
      create("Concurrent Tech B"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201,
      409,
    ]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await conflict.json()).toEqual({
      error: {
        code: "conflict",
        message:
          "You already have a sound tech profile — edit it from your profile page.",
      },
    });

    const profiles = await db()
      .select({ id: schema.techs.id })
      .from(schema.techs)
      .where(eq(schema.techs.ownerUserId, concurrentOwnerId));
    expect(profiles).toHaveLength(1);
    const creationEvents = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actor, concurrentOwnerId),
          eq(schema.events.kind, "tech.created"),
        ),
      );
    expect(creationEvents).toHaveLength(1);
  });

  it("rolls the profile back when its creation event cannot be persisted", async () => {
    const suffix = rollbackOwnerId
      .replace(/[^a-z0-9]/gi, "")
      .slice(-16)
      .toLowerCase();
    const functionName = `fail_tech_event_${suffix}`;
    const triggerName = `fail_tech_event_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.actor = '${rollbackOwnerId}' and new.kind = 'tech.created' then
          raise exception 'forced tech event failure';
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

    sessionUserId.mockResolvedValue(rollbackOwnerId);
    try {
      await expect(create("Rollback Tech")).rejects.toThrow();
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    const profiles = await db()
      .select({ id: schema.techs.id })
      .from(schema.techs)
      .where(eq(schema.techs.ownerUserId, rollbackOwnerId));
    expect(profiles).toHaveLength(0);
    const creationEvents = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actor, rollbackOwnerId),
          eq(schema.events.kind, "tech.created"),
        ),
      );
    expect(creationEvents).toHaveLength(0);
  });
});
