import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://test/api/techs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const create = (name: string) =>
  post({ name, bio: "", gear: "partial", travelRadiusMiles: 30 });

describe("sound-tech profile creation", () => {
  const concurrentOwnerId = newId("user");
  const rollbackOwnerId = newId("user");
  const fullProfileOwnerId = newId("user");
  const blankRateOwnerId = newId("user");

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
      {
        id: fullProfileOwnerId,
        email: `${fullProfileOwnerId}@tech-create.test`,
      },
      {
        id: blankRateOwnerId,
        email: `${blankRateOwnerId}@tech-create.test`,
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  /**
   * Everything else in this file counts rows. Counting cannot tell a labor rate
   * from a with-rig rate, and those two adjacent same-typed columns are the ones
   * /techs and /t/[id] publish as the price of hiring someone — a swap here
   * misquotes every engineer in the directory. Assert the whole row, in cents,
   * against the values submitted.
   */
  it("stores gear, bio, both rates in cents and the travel radius as submitted", async () => {
    sessionUserId.mockResolvedValue(fullProfileOwnerId);
    const response = await post({
      name: "Full Detail Tech",
      bio: "Twenty years of Milwaukee club stages.",
      gear: "full_rig",
      // Distinct, asymmetric, and NOT interchangeable: a rig costs more than
      // labor, so a swap reads as a real quote rather than an obvious error.
      rateLaborCents: 15_000,
      rateWithRigCents: 42_500,
      travelRadiusMiles: 75,
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const [row] = await db()
      .select()
      .from(schema.techs)
      .where(eq(schema.techs.ownerUserId, fullProfileOwnerId));
    expect(row).toMatchObject({
      id,
      ownerUserId: fullProfileOwnerId,
      name: "Full Detail Tech",
      bio: "Twenty years of Milwaukee club stages.",
      gear: "full_rig",
      rateLaborCents: 15_000,
      rateWithRigCents: 42_500,
      travelRadiusMiles: 75,
      // A new profile is discoverable and unpenalised; the directory query
      // filters on both, so a wrong default hides the tech they just created.
      status: "live",
      reliabilityStrikes: 0,
    });

    const [event] = await db()
      .select({ subjectId: schema.events.subjectId })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actor, fullProfileOwnerId),
          eq(schema.events.kind, "tech.created"),
        ),
      );
    // The event has to name the row that was written, or the worker fans out
    // about a profile nobody can open.
    expect(event?.subjectId).toBe(id);
  });

  /**
   * Rates are optional on the form, and `undefined` must land as SQL NULL —
   * /techs branches on `!= null` to choose between a price and "Rates not
   * listed", so a 0 written for a blank field advertises free work.
   */
  it("leaves unanswered rates null rather than zero", async () => {
    sessionUserId.mockResolvedValue(blankRateOwnerId);
    expect((await create("Blank Rate Tech")).status).toBe(201);
    const [row] = await db()
      .select()
      .from(schema.techs)
      .where(eq(schema.techs.ownerUserId, blankRateOwnerId));
    expect(row?.rateLaborCents).toBeNull();
    expect(row?.rateWithRigCents).toBeNull();
    expect(row?.gear).toBe("partial");
    expect(row?.travelRadiusMiles).toBe(30);
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
