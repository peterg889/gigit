import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORKER_METRICS } from "./metric-names.js";

/**
 * Journey O3: the worker's CloudWatch metrics — the channel whose entire job is
 * to tell a human that everything else has stopped.
 *
 * Nothing exercised `putMetrics` at all. The reconcile loop's health block is
 * wrapped in `catch { /* health check must never kill the loop *\/ }`, so a
 * health pass that throws on every iteration publishes nothing, logs nothing,
 * and leaves three alarms sitting in INSUFFICIENT_DATA — which reads as "fine".
 *
 * The names are asserted against apps/worker/src/metric-names.ts, the same
 * constant infra/cdk/test/infrastructure-guarantees.test.ts reads to check the
 * alarms. That constant is the join: a metric renamed on one side and not the
 * other used to leave both suites green.
 */
type MetricDatum = { MetricName?: string; Value?: number; Unit?: string;
  Dimensions?: { Name?: string; Value?: string }[] };
type PutInput = { Namespace?: string; MetricData?: MetricDatum[] };

const cw = vi.hoisted(() => ({ sends: [] as PutInput[] }));
vi.mock("@aws-sdk/client-cloudwatch", () => {
  class PutMetricDataCommand {
    constructor(public input: PutInput) {}
  }
  class CloudWatchClient {
    async send(cmd: PutMetricDataCommand) {
      cw.sends.push(cmd.input);
    }
  }
  return { CloudWatchClient, PutMetricDataCommand };
});

// The scheduled handlers are captured so the money metric can be driven
// deterministically instead of waiting on a nightly cron.
const handlers = vi.hoisted(() => new Map<string, () => Promise<void>>());
vi.mock("pg-boss", () => {
  class FakePgBoss {
    on() {}
    async start() {}
    async createQueue() {}
    async schedule() {}
    async work(name: string, handler: () => Promise<void>) {
      handlers.set(name, handler);
    }
    async stop() {}
  }
  return { default: FakePgBoss };
});

vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    // Boot self-heals are boot.test.ts's subject; here they are a full-table
    // pass this file has no use for. `outboxLagMs` stays REAL — the outbox
    // numbers being published have to come from the real query.
    snapshotNightFacts: async () => 0,
    materializeAllActiveSeries: async () => 0,
    expirePastSlots: async () => 0,
    // Forced clean: the assertion below is that a ZERO is published (the thing
    // that lets the alarm clear), and the shared test database is full of
    // half-finished bookings from every other suite.
    reconcileMoney: async () => [],
  };
});

const STAGE = "test-stage";
process.env.GIGIT_STAGE = STAGE;

const { closeDb } = await import("@gigit/db");
const { main } = await import("./index.js");

const names = (input: PutInput) => (input.MetricData ?? []).map((m) => m.MetricName);

describe("worker CloudWatch metrics", () => {
  beforeAll(async () => {
    await main();
  });

  afterAll(async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    exit.mockRestore();
    delete process.env.GIGIT_STAGE;
    await closeDb();
  });

  it("publishes exactly the outbox metrics the stack alarms on", async () => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && cw.sends.length === 0)
      await new Promise((r) => setTimeout(r, 50));
    expect(cw.sends.length).toBeGreaterThan(0);

    // Exactly these two, together, in one call: the lag alarm and the dead-letter
    // alarm are the pair that says "the fan-out is wedged" vs "work has been
    // abandoned", and dropping either from the array is a one-line edit that
    // silently retires an alarm.
    const health = cw.sends[0]!;
    expect(names(health)).toEqual([
      WORKER_METRICS.outboxLagMs,
      WORKER_METRICS.deadLetteredEvents,
    ]);
    expect(health.Namespace).toBe("Gigit");
    // Namespace + Stage dimension are what the stack's Metric() looks up. A
    // metric published without the dimension lands somewhere no alarm reads.
    for (const datum of health.MetricData ?? [])
      expect(datum.Dimensions).toEqual([{ Name: "Stage", Value: STAGE }]);
    // Units, because CloudWatch will not convert for you: the lag alarm's
    // threshold is 600000, which is ten minutes only if the value is millis.
    expect(health.MetricData?.map((m) => m.Unit)).toEqual(["Milliseconds", "Count"]);
  });

  it("publishes the money-reconciliation metric on the clean path too", async () => {
    // Emitted on BOTH paths on purpose: MoneyMismatches only ever going up means
    // the alarm never clears once the books are balanced again.
    cw.sends.length = 0;
    const reconcile = handlers.get("reconcile-money");
    expect(reconcile).toBeDefined();
    await reconcile!();
    expect(cw.sends.map(names)).toEqual([[WORKER_METRICS.moneyMismatches]]);
    expect(cw.sends[0]?.MetricData?.[0]?.Value).toBe(0);
  });

  it("sends nothing to CloudWatch when GIGIT_STAGE is unset", async () => {
    // The guard that keeps a laptop and CI off the production metric stream —
    // and, more importantly, out of a stage-less datapoint that no alarm's
    // dimension filter would ever match.
    delete process.env.GIGIT_STAGE;
    cw.sends.length = 0;
    await handlers.get("reconcile-money")!();
    expect(cw.sends).toEqual([]);
    process.env.GIGIT_STAGE = STAGE;
  });
});
