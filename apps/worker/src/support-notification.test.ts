import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";

const { sesSend, notificationConfig } = vi.hoisted(() => ({
  sesSend: vi.fn(),
  notificationConfig: {
    nodeEnv: "test" as "test" | "production",
    supportEmailTo: undefined as string | undefined,
    emailConfigured: false,
  },
}));

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: class {
      send(command: unknown) {
        return sesSend(command);
      }
    },
  };
});

vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    env: () => ({
      ...actual.env(),
      NODE_ENV: notificationConfig.nodeEnv,
      EMAIL_FROM: notificationConfig.emailConfigured
        ? "verified-sender@example.com"
        : undefined,
      SUPPORT_EMAIL_TO: notificationConfig.supportEmailTo,
    }),
    emailConfigured: () => notificationConfig.emailConfigured,
  };
});

import { closeDb, getPool } from "@gigit/db";
import { drainOutboxOnce } from "./index.js";

const noBoss = {} as unknown as PgBoss;

type EventState = {
  dispatched_at: Date | null;
  attempts: number;
  last_error: string | null;
  dead_lettered_at: Date | null;
};

async function insertEscalation(requestId: string): Promise<number> {
  const { rows } = await getPool().query(
    `insert into events (actor, kind, subject_type, subject_id, payload)
     values ('system', 'support.escalated', 'support_request', $1, '{}'::jsonb)
     returning id`,
    [requestId],
  );
  return Number(rows[0].id);
}

async function eventState(eventId: number): Promise<EventState> {
  const { rows } = await getPool().query(
    `select dispatched_at, attempts, last_error, dead_lettered_at
       from events
      where id = $1`,
    [eventId],
  );
  return rows[0] as EventState;
}

async function drainWithLogs() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const stats = await drainOutboxOnce(noBoss);
    const logs = spy.mock.calls.flatMap(([line]) => {
      try {
        return [JSON.parse(String(line)) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    return { stats, logs };
  } finally {
    spy.mockRestore();
  }
}

describe("support escalation operator notification", () => {
  beforeEach(async () => {
    notificationConfig.nodeEnv = "test";
    notificationConfig.supportEmailTo = undefined;
    notificationConfig.emailConfigured = false;
    sesSend.mockReset();
    await getPool().query(
      `update events set dispatched_at = now()
       where dispatched_at is null and dead_lettered_at is null`,
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("routes support.escalated to the configured operator log sink in test", async () => {
    notificationConfig.supportEmailTo = "support-ops@example.com";
    const requestId = "spr_operator_sink";
    const eventId = await insertEscalation(requestId);

    const { stats, logs } = await drainWithLogs();
    const state = await eventState(eventId);

    expect(stats).toMatchObject({ processed: 1, dispatched: 1, deadLettered: 0 });
    expect(state.dispatched_at).not.toBeNull();
    expect(state).toMatchObject({
      attempts: 0,
      last_error: null,
      dead_lettered_at: null,
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        kind: "notify.log_sink",
        destination: "support-ops@example.com",
        template: "support_escalated",
        requestId,
      }),
    );
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("keeps the escalation retryable when production operator config is missing", async () => {
    notificationConfig.nodeEnv = "production";
    const eventId = await insertEscalation("spr_missing_operator_config");

    const { stats } = await drainWithLogs();
    const state = await eventState(eventId);

    expect(stats).toMatchObject({ processed: 1, dispatched: 0, deadLettered: 0 });
    expect(state.dispatched_at).toBeNull();
    expect(state.attempts).toBe(1);
    expect(state.dead_lettered_at).toBeNull();
    expect(state.last_error).toContain(
      "SUPPORT_EMAIL_TO and EMAIL_FROM are required",
    );
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("keeps the escalation retryable when SES rejects the operator email", async () => {
    notificationConfig.nodeEnv = "production";
    notificationConfig.supportEmailTo = "support-ops@example.com";
    notificationConfig.emailConfigured = true;
    sesSend.mockRejectedValueOnce(new Error("SES temporarily unavailable"));
    const eventId = await insertEscalation("spr_ses_failure");

    const { stats } = await drainWithLogs();
    const state = await eventState(eventId);

    expect(stats).toMatchObject({ processed: 1, dispatched: 0, deadLettered: 0 });
    expect(state.dispatched_at).toBeNull();
    expect(state.attempts).toBe(1);
    expect(state.dead_lettered_at).toBeNull();
    expect(state.last_error).toContain("SES temporarily unavailable");
    expect(sesSend).toHaveBeenCalledOnce();
  });

  it("sends configured production escalations to SES before dispatching", async () => {
    notificationConfig.nodeEnv = "production";
    notificationConfig.supportEmailTo = "support-ops@example.com";
    notificationConfig.emailConfigured = true;
    sesSend.mockResolvedValueOnce({ MessageId: "ses_test" });
    const requestId = "spr_ses_success";
    const eventId = await insertEscalation(requestId);

    const { stats } = await drainWithLogs();
    const state = await eventState(eventId);

    expect(stats).toMatchObject({ processed: 1, dispatched: 1, deadLettered: 0 });
    expect(state.dispatched_at).not.toBeNull();
    expect(state.attempts).toBe(0);
    expect(sesSend).toHaveBeenCalledOnce();

    const command = sesSend.mock.calls[0]?.[0] as {
      input: {
        Destination: { ToAddresses: string[] };
        Content: { Simple: { Body: { Text: { Data: string } } } };
      };
    };
    expect(command.input.Destination.ToAddresses).toEqual([
      "support-ops@example.com",
    ]);
    expect(command.input.Content.Simple.Body.Text.Data).toContain(
      `/admin/support/${requestId}`,
    );
  });
});
