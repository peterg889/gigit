import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { drainOutboxOnce } from "./index.js";

/**
 * Notification delivery routing (the "log for now" gap): the OTP login code,
 * application-to-venue, and message-to-counterparty notifications were never
 * delivered. With no Twilio/SES env configured, notifyUser/notifyDestination
 * fall to a structured `notify.log_sink` line — so we drive each event through
 * the real outbox and assert the right recipient was resolved.
 */
const noBoss = {} as unknown as PgBoss;

describe("worker notification routing", () => {
  const venueOwner = newId("user");
  const bandOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const slotId = newId("slot");
  const threadId = newId("thread");
  const otpId = newId("user");
  const otpDest = "login@routing.test";

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([venueOwner, bandOwner].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwner,
      kind: "bar",
      name: "Routing Bar",
      metro: "route-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: bandOwner,
      kind: "band",
      name: "Routing Band",
      homeMetro: "route-tv",
    });
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "route-tv",
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await d.insert(schema.threads).values({ id: threadId, scope: "inquiry" });
    await d.insert(schema.threadParticipants).values([
      { threadId, userId: venueOwner },
      { threadId, userId: bandOwner },
    ]);
    await d.insert(schema.authOtps).values({
      id: otpId,
      destination: otpDest,
      code: "424242",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  /** Park backlog, inject events, drain, and return the notify.log_sink lines. */
  async function drainAndCaptureSinks(
    events: { kind: string; subjectType: string; subjectId: string; actor: string; payload: unknown }[],
  ) {
    await getPool().query(
      `update events set dispatched_at = now() where dispatched_at is null and dead_lettered_at is null`,
    );
    for (const e of events)
      await getPool().query(
        `insert into events (actor, kind, subject_type, subject_id, payload)
         values ($1,$2,$3,$4,$5::jsonb)`,
        [e.actor, e.kind, e.subjectType, e.subjectId, JSON.stringify(e.payload)],
      );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await drainOutboxOnce(noBoss);
    const calls = spy.mock.calls.slice();
    spy.mockRestore();
    return calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.kind === "notify.log_sink");
  }

  const notify = (template: string, to: string, extra: Record<string, unknown> = {}) => ({
    ...extra,
    effects: [{ kind: "notify", template, to }],
  });

  it("routes OTP, application, and message notifications to the right recipients", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "auth.otp_requested",
        subjectType: "auth",
        subjectId: otpDest,
        actor: "system",
        payload: notify("otp", "both", { otpId }),
      },
      {
        kind: "slot.application",
        subjectType: "slot",
        subjectId: slotId,
        actor: bandOwner,
        payload: notify("new_application", "venue"),
      },
      {
        kind: "message.sent",
        subjectType: "thread",
        subjectId: threadId,
        actor: venueOwner, // the sender — must NOT be notified
        payload: notify("new_message", "both"),
      },
    ]);

    // OTP → delivered to the raw destination (signup may have no user row yet)
    expect(sinks).toContainEqual(
      expect.objectContaining({ destination: otpDest, template: "otp" }),
    );
    // application → the slot's venue owner
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: venueOwner, template: "new_application" }),
    );
    // message → the other participant only, never the sender
    const msgRecipients = sinks
      .filter((s) => s.template === "new_message")
      .map((s) => s.userId);
    expect(msgRecipients).toEqual([bandOwner]);
  });
});
